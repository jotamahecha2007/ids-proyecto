/**
 * Cliente SMTP mínimo sobre un socket TCP cifrado con TLS (puerto 465, "SMTPS").
 *
 * No usamos un servicio intermedio: la app habla el protocolo SMTP directamente
 * con smtp.gmail.com, igual que un cliente de correo.
 *
 *   App ──TCP+TLS:465──> smtp.gmail.com
 *   S: 220 listo                C: EHLO
 *   S: 250-…/250 …              C: AUTH LOGIN (usuario y contraseña en base64)
 *   S: 334 / 334 / 235          C: MAIL FROM / RCPT TO
 *   S: 250 / 250                C: DATA
 *   S: 354                      C: <mensaje MIME> + "\r\n.\r\n"
 *   S: 250 encolado             C: QUIT
 *
 * El socket se inyecta (SocketFactory) para poder probar el protocolo con un
 * servidor simulado en Node.js sin depender del teléfono.
 */
import { b64, buildMime, dotStuff, Mail } from '../utils/mime';

export interface SocketLike {
  write(data: string): unknown;
  on(event: 'data', cb: (d: unknown) => void): unknown;
  on(event: 'error', cb: (e: Error) => void): unknown;
  on(event: 'close', cb: () => void): unknown;
  destroy(): unknown;
}

/** Debe resolver con el socket ya conectado (y con el handshake TLS completo). */
export type SocketFactory = (host: string, port: number) => Promise<SocketLike>;

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  timeoutMs?: number;
  clientName?: string;
}

interface Reply { code: number; lines: string[] }

export class SmtpError extends Error {
  constructor(message: string, public code?: number, public stage?: string) { super(message); }
}

class SmtpSession {
  private buffer = '';
  private pendingLines: string[] = [];
  private replies: Reply[] = [];
  private waiter: ((r: Reply) => void) | null = null;
  private failure: Error | null = null;
  private failWaiter: ((e: Error) => void) | null = null;

  constructor(private sock: SocketLike, private timeoutMs: number) {
    sock.on('data', d => this.onData(typeof d === 'string' ? d : String(d)));
    sock.on('error', e => this.fail(e));
    sock.on('close', () => this.fail(new SmtpError('El servidor cerró la conexión')));
  }

  /**
   * TCP es un flujo de bytes: una respuesta puede llegar partida en varios
   * paquetes, o varias respuestas en uno solo. Se acumula en un búfer y se
   * separa por CRLF. Una respuesta multilínea usa "250-" en las líneas
   * intermedias y "250 " (con espacio) en la última.
   */
  private onData(chunk: string) {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      this.pendingLines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), lines: this.pendingLines };
        this.pendingLines = [];
        if (this.waiter) { const w = this.waiter; this.waiter = null; this.failWaiter = null; w(reply); }
        else this.replies.push(reply);
      }
    }
  }

  private fail(e: Error) {
    if (this.failure) return;
    this.failure = e;
    if (this.failWaiter) { const f = this.failWaiter; this.waiter = null; this.failWaiter = null; f(e); }
  }

  read(stage: string): Promise<Reply> {
    const queued = this.replies.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiter = null; this.failWaiter = null;
        reject(new SmtpError(`Tiempo de espera agotado en ${stage}`, undefined, stage));
      }, this.timeoutMs);
      this.waiter = r => { clearTimeout(t); resolve(r); };
      this.failWaiter = e => { clearTimeout(t); reject(e); };
    });
  }

  async expect(stage: string, ok: number[]): Promise<Reply> {
    const r = await this.read(stage);
    if (!ok.includes(r.code)) {
      throw new SmtpError(`${stage}: el servidor respondió ${r.lines.join(' | ')}`, r.code, stage);
    }
    return r;
  }

  async command(stage: string, line: string, ok: number[]): Promise<Reply> {
    this.sock.write(line + '\r\n');
    return this.expect(stage, ok);
  }

  /** Envía bloques grandes (la foto en base64 puede pesar varios cientos de KB). */
  writeChunked(data: string, chunkSize = 16 * 1024) {
    for (let i = 0; i < data.length; i += chunkSize) this.sock.write(data.slice(i, i + chunkSize));
  }
}

export async function sendMail(cfg: SmtpConfig, mail: Mail, connect: SocketFactory): Promise<string> {
  const timeout = cfg.timeoutMs ?? 20000;

  const sock = await withTimeout(connect(cfg.host, cfg.port), timeout, 'conexión TLS');
  const s = new SmtpSession(sock, timeout);
  try {
    await s.expect('saludo', [220]);
    await s.command('EHLO', `EHLO ${cfg.clientName ?? 'ids-mobile'}`, [250]);
    await s.command('AUTH', 'AUTH LOGIN', [334]);
    await s.command('AUTH usuario', b64(cfg.user), [334]);
    await s.command('AUTH contraseña', b64(cfg.pass), [235]);
    await s.command('MAIL FROM', `MAIL FROM:<${mail.from}>`, [250]);
    for (const rcpt of mail.to) await s.command('RCPT TO', `RCPT TO:<${rcpt}>`, [250, 251]);
    await s.command('DATA', 'DATA', [354]);
    s.writeChunked(dotStuff(buildMime(mail)) + '\r\n.\r\n');
    const done = await s.expect('fin de DATA', [250]);
    try { await s.command('QUIT', 'QUIT', [221]); } catch { /* no es crítico */ }
    return done.lines.join(' ');
  } finally {
    sock.destroy();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, stage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new SmtpError(`Tiempo de espera agotado en ${stage}`, undefined, stage)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}
