/**
 * Construcción de mensajes MIME (RFC 5322 / RFC 2045-2047) para el correo de alerta.
 * Todo el contenido se codifica en base64 para que el mensaje sea 7-bit seguro
 * y ninguna línea supere los 76 caracteres.
 */
import { Buffer } from 'buffer';

export interface MailAttachment {
  filename: string;
  contentType: string;   // p.ej. "image/jpeg"
  base64: string;        // contenido ya en base64 (sin saltos de línea)
}

export interface Mail {
  from: string;          // correo del remitente
  fromName?: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: MailAttachment[];
}

export const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/** Parte el base64 en líneas de 76 caracteres (límite de RFC 2045). */
export function wrap76(base64: string): string {
  const clean = base64.replace(/\s+/g, '');
  const lines: string[] = [];
  for (let i = 0; i < clean.length; i += 76) lines.push(clean.slice(i, i + 76));
  return lines.join('\r\n');
}

/** Encabezado con caracteres no ASCII (tildes, emoji) -> "encoded-word" RFC 2047. */
export function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${b64(value)}?=`;
}

/** Fecha en formato RFC 5322: "Sun, 04 Oct 2026 10:43:00 -0500". */
export function rfc5322Date(d: Date = new Date()): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${days[d.getDay()]}, ${p(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${sign}${p(Math.floor(abs / 60))}${p(abs % 60)}`;
}

const boundary = (tag: string) => `----=_ids_${tag}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export function buildMime(mail: Mail): string {
  const mixed = boundary('mixed');
  const alt = boundary('alt');
  const fromHeader = mail.fromName ? `${encodeHeader(mail.fromName)} <${mail.from}>` : `<${mail.from}>`;
  const domain = mail.from.split('@')[1] || 'ids.local';

  const headers = [
    `From: ${fromHeader}`,
    `To: ${mail.to.map(t => `<${t}>`).join(', ')}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    `Date: ${rfc5322Date()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@${domain}>`,
    'MIME-Version: 1.0',
    'X-Priority: 1',
    'Importance: high',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
  ];

  const parts: string[] = [];
  parts.push(
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(mail.text)),
  );
  if (mail.html) {
    parts.push(
      `--${alt}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(b64(mail.html)),
    );
  }
  parts.push(`--${alt}--`);

  for (const a of mail.attachments ?? []) {
    parts.push(
      `--${mixed}`,
      `Content-Type: ${a.contentType}; name="${a.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${a.filename}"`,
      '',
      wrap76(a.base64),
    );
  }
  parts.push(`--${mixed}--`);

  return headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n') + '\r\n';
}

/**
 * "Dot-stuffing" (RFC 5321 §4.5.2): en la fase DATA, una línea que es solo "."
 * termina el mensaje; por eso toda línea que empiece con "." se duplica.
 * También normaliza los saltos de línea a CRLF.
 */
export function dotStuff(data: string): string {
  return data.replace(/\r?\n/g, '\r\n').replace(/(^|\r\n)\./g, '$1..');
}
