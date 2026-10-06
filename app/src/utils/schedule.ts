/**
 * Lógica de franjas horarias de vigilancia (pura, sin dependencias de React Native,
 * para poder probarla de forma aislada).
 */
import type { Schedule } from '../store';

export const DAY_LABELS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

/** "HH:MM" -> minutos desde medianoche, o null si el formato es inválido. */
export function toMinutes(hhmm: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * ¿La franja está activa en el instante `d`?
 *  - start < end  : franja normal dentro del mismo día (08:00–17:00).
 *  - start > end  : franja nocturna que cruza la medianoche (22:00–06:00).
 *                   El día marcado es el día en que EMPIEZA la franja, así que
 *                   el lunes 02:00 pertenece a la franja que empezó el domingo.
 *  - start == end : todo el día.
 */
export function isScheduleActive(s: Schedule, d: Date): boolean {
  if (!s.enabled || s.days.length === 0) return false;
  const start = toMinutes(s.start);
  const end = toMinutes(s.end);
  if (start === null || end === null) return false;

  const now = d.getHours() * 60 + d.getMinutes();
  const today = d.getDay();
  const yesterday = (today + 6) % 7;

  if (start === end) return s.days.includes(today);
  if (start < end) return s.days.includes(today) && now >= start && now < end;
  return (s.days.includes(today) && now >= start) || (s.days.includes(yesterday) && now < end);
}

export interface ArmedInfo { armed: boolean; reason: string }

/** Estado efectivo de armado: modo manual "Fuera de casa" OR alguna franja activa. */
export function evaluateArmed(manualAway: boolean, schedules: Schedule[], d: Date = new Date()): ArmedInfo {
  if (manualAway) return { armed: true, reason: 'Modo "Fuera de casa" activado' };
  const active = schedules.find(s => isScheduleActive(s, d));
  if (active) return { armed: true, reason: `Franja "${active.label}" (${active.start}–${active.end})` };
  return { armed: false, reason: 'Sin franja activa' };
}

export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
