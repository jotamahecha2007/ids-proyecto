/**
 * Cliente WebSocket hacia el ESP32 con reconexión automática.
 *
 * Robustez ante cortes de Wi-Fi:
 *  1. Timeout de conexión: si el handshake no termina en 5 s se aborta.
 *  2. Watchdog de latidos: el ESP32 envía {"type":"hb"} cada 2 s. Si pasan
 *     7 s sin NINGÚN mensaje, la conexión se considera muerta aunque el
 *     sistema operativo no lo haya notado (TCP "medio abierto") y se fuerza
 *     la reconexión.
 *  3. Backoff exponencial con jitter: 0.5 s, 1 s, 2 s … hasta 30 s, con
 *     aleatoriedad para no saturar al ESP32 si varios clientes reconectan a la vez.
 *  4. Resincronización: al reconectar se envía {"cmd":"sync","lastId":N} y el
 *     ESP32 reenvía los eventos que ocurrieron mientras no había conexión.
 *  5. Ping de aplicación cada 5 s para medir la latencia (RTT).
 */
import type { ConnStatus } from '../store';

export interface EspMessage {
  type: 'hello' | 'state' | 'hb' | 'motion' | 'pong' | 'error';
  [k: string]: any;
}

export interface Esp32Handlers {
  onStatus: (s: ConnStatus, nextRetryMs?: number) => void;
  onMessage: (m: EspMessage) => void;
  onRtt: (ms: number) => void;
  /** Se llama al abrir la conexión: lo que la app quiere enviar primero. */
  onOpen: (send: (o: object) => boolean) => void;
}

const CONNECT_TIMEOUT_MS = 5000;
const SILENCE_TIMEOUT_MS = 7000;
const PING_INTERVAL_MS = 5000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30000;

export class Esp32Client {
  private ws: WebSocket | null = null;
  private url = '';
  private stopped = true;
  private attempt = 0;
  private lastMsgAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private pinger: ReturnType<typeof setInterval> | null = null;

  constructor(private h: Esp32Handlers) {}

  start(url: string) {
    this.url = url;
    this.stopped = false;
    this.attempt = 0;
    this.teardown();
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.clearRetry();
    this.teardown();
    this.h.onStatus('disconnected');
  }

  /** Reconectar ya (p. ej. la app volvió a primer plano). */
  reconnectNow() {
    if (this.stopped) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    this.clearRetry();
    this.attempt = 0;
    this.teardown();
    this.connect();
  }

  get isOpen() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  send(obj: object): boolean {
    if (!this.isOpen) return false;
    try {
      this.ws!.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------
  private connect() {
    if (this.stopped) return;
    this.h.onStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    this.connectTimer = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) this.dropAndRetry(ws);
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.clearConnectTimer();
      this.attempt = 0;
      this.lastMsgAt = Date.now();
      this.h.onStatus('connected');
      this.h.onOpen(o => this.send(o));
      this.startTimers(ws);
    };

    ws.onmessage = ev => {
      if (ws !== this.ws) return;
      this.lastMsgAt = Date.now();
      let msg: EspMessage;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return; // mensaje corrupto: se ignora, no tumba la conexión
      }
      if (msg.type === 'pong' && typeof msg.t === 'number') {
        this.h.onRtt(Date.now() - msg.t);
        return;
      }
      this.h.onMessage(msg);
    };

    ws.onerror = () => {
      /* onclose llega después; ahí se decide reconectar */
    };

    ws.onclose = () => {
      if (ws !== this.ws) return; // cierre de un socket viejo que ya descartamos
      this.dropAndRetry(ws);
    };
  }

  private startTimers(ws: WebSocket) {
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastMsgAt > SILENCE_TIMEOUT_MS) this.dropAndRetry(ws);
    }, 1000);
    this.pinger = setInterval(() => this.send({ cmd: 'ping', t: Date.now() }), PING_INTERVAL_MS);
  }

  /** Descarta el socket actual (sin esperar a que el SO lo cierre) y programa reintento. */
  private dropAndRetry(ws: WebSocket) {
    if (ws !== this.ws) return;
    this.teardown();
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempt);
    const delay = Math.round(exp / 2 + Math.random() * (exp / 2)); // "equal jitter"
    this.attempt++;
    this.h.onStatus('reconnecting', delay);
    this.clearRetry();
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private teardown() {
    this.clearConnectTimer();
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.pinger) clearInterval(this.pinger);
    this.watchdog = this.pinger = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try { ws.close(); } catch { /* ya estaba cerrado */ }
    }
  }

  private clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private clearConnectTimer() {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }
}
