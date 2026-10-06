/**
 * Pipeline de alerta: movimiento -> ¿sistema armado? -> antispam ->
 * notificación local inmediata -> captura de evidencia -> correo (cola con reintentos).
 *
 * Fuentes de movimiento:
 *  - 'camera': detección por imagen en este mismo celular (fuente principal).
 *  - 'esp32' : evento generado por el ESP32 (p. ej. "Simular intrusión").
 */
import { addLog, getState, setState } from '../store';
import { evaluateArmed, formatDateTime } from '../utils/schedule';
import type { MailAttachment } from '../utils/mime';
import { cameraBridge } from './CameraBridge';
import { notifyIntrusion } from './ForegroundService';
import { enqueueMail, mailConfig, mailConfigured } from './Mailer';

export interface MotionInput {
  source: 'camera' | 'esp32';
  id?: number;            // id del ESP32 (solo eventos que vienen del ESP32)
  iso?: string;           // hora del ESP32 (NTP)
  score?: number;         // fracción de imagen que cambió (detección por cámara)
  simulated?: boolean;
  replay?: boolean;
  registeredOnEsp?: boolean;
}

let suppressedSinceLastEmail = 0;

export async function handleMotion(ev: MotionInput) {
  const receivedAt = Date.now();
  const st = getState();

  // Idempotencia para eventos del ESP32: uno reenviado por "sync" que ya
  // procesamos se ignora.
  if (ev.source === 'esp32' && ev.id) {
    if (!ev.simulated && ev.id <= st.lastEventId) return;
    if (ev.id > st.lastEventId) setState({ lastEventId: ev.id });
  }

  const pct = ev.score != null ? ` ${(ev.score * 100).toFixed(1)} % de la imagen` : '';
  const tag = ev.source === 'camera'
    ? `cámara${pct}`
    : `ESP32 #${ev.id}${ev.simulated ? ' simulado' : ''}${ev.replay ? ' recuperado' : ''}`;
  const armed = evaluateArmed(st.manualAway, st.schedules, new Date(receivedAt));

  if (!armed.armed) {
    addLog('motion', `Movimiento (${tag}) ignorado: sistema desarmado`);
    return;
  }
  addLog('motion', `¡Movimiento! (${tag}) — ${armed.reason}`);

  const when = formatDateTime(receivedAt);
  await notifyIntrusion('🚨 Intrusión detectada', `${when} · ${armed.reason}`).catch(() => {});

  if (!mailConfigured()) {
    addLog('error', 'Correo no configurado: ve a Ajustes');
    return;
  }

  // Antispam: como máximo un correo cada N segundos; los demás se cuentan.
  const minGap = st.settings.minEmailIntervalSec * 1000;
  if (receivedAt - st.lastEmailAt < minGap) {
    suppressedSinceLastEmail++;
    addLog('info', `Correo agrupado (antispam ${st.settings.minEmailIntervalSec} s)`);
    return;
  }
  setState({ lastEmailAt: receivedAt });
  const extra = suppressedSinceLastEmail;
  suppressedSinceLastEmail = 0;

  const photo = st.settings.attachPhoto ? await cameraBridge.capture(4000) : null;
  if (st.settings.attachPhoto && !photo) addLog('info', 'Sin foto (cámara no disponible): se envía marca temporal');

  const attachments: MailAttachment[] = photo
    ? [{ filename: `intrusion_${receivedAt}.jpg`, contentType: 'image/jpeg', base64: photo.base64 }]
    : [];

  const rows: [string, string][] = [
    ['Fecha y hora (teléfono)', when],
    ['Fecha y hora (ESP32)', ev.iso || (ev.source === 'camera' ? '—' : 'sin sincronizar NTP')],
    ['Origen', ev.source === 'camera'
      ? `Detección por imagen (cámara del celular)${pct ? ' — cambió el' + pct : ''}`
      : `ESP32, evento #${ev.id}${ev.simulated ? ' (simulado)' : ''}${ev.replay ? ' (recuperado tras reconexión)' : ''}`],
    ['Registrado en el ESP32', ev.source === 'esp32' ? 'sí' : ev.registeredOnEsp ? 'sí' : 'no (ESP32 desconectado)'],
    ['Motivo de armado', armed.reason],
    ['Evidencia', photo ? 'foto adjunta' : 'marca temporal (sin foto)'],
  ];
  if (extra > 0) rows.push(['Eventos agrupados desde el último correo', String(extra)]);

  const text = ['Se detectó movimiento en el espacio vigilado.', '', ...rows.map(([k, v]) => `${k}: ${v}`)].join('\n');
  const html = `<div style="font-family:Arial,sans-serif">
<h2 style="color:#c62828">🚨 Intrusión detectada</h2>
<table cellpadding="4">${rows.map(([k, v]) => `<tr><td><b>${escapeHtml(k)}</b></td><td>${escapeHtml(v)}</td></tr>`).join('')}</table>
<p style="color:#666">Sistema de Detección de Intrusos IoT — ESP32 + app móvil</p></div>`;

  const { smtp, to } = mailConfig();
  enqueueMail(
    {
      from: smtp.user,
      fromName: 'IDS Alertas',
      to,
      subject: `🚨 Intrusión detectada — ${when.slice(0, 19)}`,
      text,
      html,
      attachments,
    },
    tag,
  );
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}
