/**
 * Envío de correos desde el teléfono: conecta el cliente SMTP con un socket
 * TLS nativo (react-native-tcp-socket) y añade una cola con reintentos.
 */
import TcpSocket from 'react-native-tcp-socket';
import { getState, addLog } from '../store';
import type { Mail } from '../utils/mime';
import { sendMail, SmtpError, SocketFactory, SocketLike } from './SmtpClient';

const rnTlsSocket: SocketFactory = (host, port) =>
  new Promise((resolve, reject) => {
    // connectTLS: abre TCP y hace el handshake TLS (verifica el certificado de Gmail).
    const sock = TcpSocket.connectTLS({ host, port }, () => resolve(sock as unknown as SocketLike));
    sock.once('error', reject);
  });

export function mailConfig() {
  const s = getState().settings;
  return {
    smtp: { host: s.smtpHost, port: s.smtpPort, user: s.smtpUser.trim(), pass: s.smtpPass.replace(/\s+/g, '') },
    to: s.alertTo.split(',').map(t => t.trim()).filter(Boolean),
  };
}

export function mailConfigured() {
  const { smtp, to } = mailConfig();
  return !!smtp.user && !!smtp.pass && to.length > 0;
}

export async function sendNow(mail: Mail) {
  const { smtp } = mailConfig();
  return sendMail(smtp, mail, rnTlsSocket);
}

// --- Cola en memoria con reintentos (backoff 5 s, 20 s, 60 s)
interface Job { mail: Mail; attempts: number; label: string }
const queue: Job[] = [];
let busy = false;
const RETRY_DELAYS = [5000, 20000, 60000];

export function enqueueMail(mail: Mail, label: string) {
  queue.push({ mail, attempts: 0, label });
  void processQueue();
}

async function processQueue() {
  if (busy) return; // un solo envío a la vez (evita conexiones SMTP paralelas)
  busy = true;
  try {
    while (queue.length) {
      const job = queue[0];
      try {
        const t0 = Date.now();
        await sendNow(job.mail);
        queue.shift();
        addLog('alert', `Correo enviado (${job.label}) en ${Date.now() - t0} ms`);
      } catch (e) {
        const err = e as SmtpError;
        // 535 = credenciales inválidas: reintentar no sirve.
        const permanent = err.code === 535 || (err.code !== undefined && err.code >= 500 && err.code < 600);
        if (permanent || job.attempts >= RETRY_DELAYS.length) {
          queue.shift();
          addLog('error', `Correo descartado (${job.label}): ${err.message}`);
          continue;
        }
        const delay = RETRY_DELAYS[job.attempts++];
        addLog('error', `Fallo al enviar (${err.message}). Reintento en ${delay / 1000} s`);
        await new Promise<void>(r => setTimeout(r, delay));
      }
    }
  } finally {
    busy = false;
  }
}
