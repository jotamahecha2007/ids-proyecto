/**
 * Orquestador de la supervisión: une el WebSocket del ESP32, el servicio en
 * primer plano, la evaluación de horarios y el pipeline de alertas.
 * Vive fuera de React para seguir funcionando con la app en segundo plano.
 */
import { addLog, EspStatus, getState, setState } from '../store';
import { evaluateArmed } from '../utils/schedule';
import { handleMotion } from './AlertService';
import { Esp32Client, EspMessage } from './Esp32Client';
import { showMonitorNotification, stopMonitorService } from './ForegroundService';

const STATUS_TEXT: Record<string, string> = {
  connected: 'Conectado al ESP32',
  connecting: 'Conectando…',
  reconnecting: 'Reconectando…',
  disconnected: 'Desconectado',
};

let scheduleTimer: ReturnType<typeof setInterval> | null = null;
let lastArmedSent: boolean | null = null;
let lastNotifText = '';

const client = new Esp32Client({
  onStatus: (conn, nextRetryMs) => {
    const prev = getState().conn;
    setState({ conn, nextRetryMs: nextRetryMs ?? null, ...(conn !== 'connected' ? { rttMs: null } : {}) });
    if (prev !== conn) {
      if (conn === 'connected') addLog('info', 'Conectado al ESP32');
      if (conn === 'reconnecting' && prev === 'connected') addLog('error', 'Conexión perdida con el ESP32, reconectando…');
      void refreshNotification();
    }
  },
  onRtt: ms => setState({ rttMs: ms }),
  onOpen: send => {
    lastArmedSent = null;
    // Lo primero tras (re)conectar: pedir los eventos que nos perdimos.
    send({ cmd: 'sync', lastId: getState().lastEventId });
    syncArmedToDevice();
  },
  onMessage: onEspMessage,
});

function onEspMessage(m: EspMessage) {
  switch (m.type) {
    case 'hello': {
      // Si el ESP32 se reinició, sus ids vuelven a empezar en 1.
      const st = getState();
      if (typeof m.lastId === 'number' && m.lastId < st.lastEventId) {
        addLog('info', `El ESP32 se reinició (lastId ${m.lastId} < ${st.lastEventId}); contador reiniciado`);
        setState({ lastEventId: 0 });
        client.send({ cmd: 'sync', lastId: 0 }); // recupera los eventos ocurridos tras el reinicio
      }
      setState({ esp: m as EspStatus });
      break;
    }
    case 'state':
    case 'hb':
      setState({ esp: m as EspStatus });
      break;
    case 'motion':
      if (m.sensor === 'CAMERA') {
        // Eco de un evento que ESTE celular detectó y reportó: ya se procesó
        // localmente, solo se actualiza el último id para la resincronización.
        if (m.id > getState().lastEventId) setState({ lastEventId: m.id });
      } else {
        void handleMotion({ source: 'esp32', id: m.id, iso: m.iso, simulated: m.simulated, replay: m.replay });
      }
      break;
    case 'error':
      addLog('error', `ESP32: ${m.error}`);
      break;
  }
}

/** Envía al ESP32 el estado de armado efectivo (para su LED/indicador). */
export function syncArmedToDevice() {
  const { manualAway, schedules } = getState();
  const { armed } = evaluateArmed(manualAway, schedules);
  if (armed !== lastArmedSent && client.send({ cmd: 'arm', value: armed })) lastArmedSent = armed;
  void refreshNotification();
}

async function refreshNotification() {
  const st = getState();
  if (!st.monitoring) return;
  const armed = evaluateArmed(st.manualAway, st.schedules);
  const text = `${STATUS_TEXT[st.conn]} · ${armed.armed ? '🔴 ARMADO' : '⚪ Desarmado'}`;
  if (text === lastNotifText) return;
  lastNotifText = text;
  try {
    await showMonitorNotification('Vigilancia IDS', `${text}\n${armed.reason}`);
  } catch (e) {
    addLog('error', `No se pudo actualizar el servicio: ${String(e)}`);
  }
}

export function wsUrl() {
  const { espHost, wsPort } = getState().settings;
  return `ws://${espHost.trim()}:${wsPort}/`;
}

export async function startMonitoring() {
  if (getState().monitoring) return;
  setState({ monitoring: true });
  lastNotifText = '';
  await refreshNotification(); // inicia el Foreground Service
  client.start(wsUrl());
  // Las franjas se reevalúan cada 15 s (cambio de franja => se notifica al ESP32).
  scheduleTimer = setInterval(syncArmedToDevice, 15000);
  addLog('info', `Supervisión iniciada (${wsUrl()})`);
}

export async function stopMonitoring() {
  if (!getState().monitoring) return;
  if (scheduleTimer) clearInterval(scheduleTimer);
  scheduleTimer = null;
  client.stop();
  setState({ monitoring: false, esp: null });
  await stopMonitorService();
  addLog('info', 'Supervisión detenida');
}

export async function restartConnection() {
  if (!getState().monitoring) return;
  client.start(wsUrl());
}

/**
 * Movimiento confirmado por la cámara. Se procesa de inmediato en el celular
 * (no depende de la red) y además se reporta al ESP32 para que lo registre,
 * le asigne id y hora NTP, y encienda su LED.
 */
export function reportCameraMotion(score: number) {
  const registeredOnEsp = client.send({ cmd: 'report', source: 'camera', score: Number(score.toFixed(4)), t: Date.now() });
  if (!registeredOnEsp && getState().monitoring) addLog('info', 'ESP32 desconectado: el evento solo queda en el celular');
  void handleMotion({ source: 'camera', score, registeredOnEsp });
}

export const reconnectNow = () => client.reconnectNow();
export const sendTestEvent = () => client.send({ cmd: 'test' });
