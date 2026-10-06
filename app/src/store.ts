/**
 * Estado global de la app (patrón "store" mínimo, sin librerías externas).
 *
 * - Un único objeto inmutable `state`; cada cambio crea un objeto nuevo.
 * - Los componentes se suscriben con `useStore(selector)` (useSyncExternalStore),
 *   y los servicios (que viven fuera de React, incluso en segundo plano)
 *   usan `getState()` / `setState()`.
 * - Lo que debe sobrevivir a un reinicio se persiste en AsyncStorage.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

export type ConnStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface Schedule {
  id: string;
  label: string;
  days: number[];   // 0 = domingo … 6 = sábado (igual que Date.getDay())
  start: string;    // "HH:MM"
  end: string;      // "HH:MM"  (si end < start, la franja cruza la medianoche)
  enabled: boolean;
}

export interface Settings {
  espHost: string;          // IP del ESP32 (STA) o 192.168.4.1 (AP)
  wsPort: number;
  smtpHost: string;
  smtpPort: number;         // 465 = TLS implícito
  smtpUser: string;         // cuenta Gmail remitente
  smtpPass: string;         // contraseña de aplicación de Google (16 caracteres)
  alertTo: string;          // destinatarios separados por coma
  minEmailIntervalSec: number;
  attachPhoto: boolean;
  areaThresholdPct: number; // % de la imagen que debe cambiar para contar como movimiento
  pixelThreshold: number;   // diferencia mínima de brillo (0-255) para que un punto "cambie"
}

export interface EspStatus {
  device?: string;
  armed?: boolean;
  lastId?: number;
  uptime?: number;
  rssi?: number;
  staIp?: string;
  timeSynced?: boolean;
  dropped?: number;
}

export type LogKind = 'motion' | 'alert' | 'info' | 'error';
export interface LogEntry { id: string; at: number; kind: LogKind; text: string }

export interface AppState {
  hydrated: boolean;
  settings: Settings;
  schedules: Schedule[];
  manualAway: boolean;      // "Fuera de casa" activado a mano
  monitoring: boolean;      // servicio de supervisión iniciado
  conn: ConnStatus;
  nextRetryMs: number | null;
  rttMs: number | null;
  esp: EspStatus | null;
  lastEventId: number;      // último id de evento procesado (para resincronizar)
  lastEmailAt: number;
  log: LogEntry[];
  motion: { score: number; brightness: number; state: string };
}

export const DEFAULT_SETTINGS: Settings = {
  espHost: '192.168.4.1',
  wsPort: 81,
  smtpHost: 'smtp.gmail.com',
  smtpPort: 465,
  smtpUser: '',
  smtpPass: '',
  alertTo: '',
  minEmailIntervalSec: 60,
  attachPhoto: true,
  areaThresholdPct: 2,
  pixelThreshold: 25,
};

let state: AppState = {
  hydrated: false,
  settings: DEFAULT_SETTINGS,
  schedules: [],
  manualAway: false,
  monitoring: false,
  conn: 'disconnected',
  nextRetryMs: null,
  rttMs: null,
  esp: null,
  lastEventId: 0,
  lastEmailAt: 0,
  log: [],
  motion: { score: 0, brightness: 0, state: 'warmup' },
};

const listeners = new Set<() => void>();
const PERSIST_KEY = 'ids/state/v1';
const MAX_LOG = 200;

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  listeners.forEach(l => l());
  if ('settings' in p || 'schedules' in p || 'manualAway' in p || 'lastEventId' in p || 'lastEmailAt' in p) {
    schedulePersist();
  }
}

export function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

export function addLog(kind: LogKind, text: string) {
  const entry: LogEntry = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: Date.now(), kind, text };
  setState(s => ({ log: [entry, ...s.log].slice(0, MAX_LOG) }));
  console.log(`[${kind}] ${text}`);
}

// --- Persistencia (con "debounce" para no escribir en disco en cada cambio)
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist() {
  if (!state.hydrated) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    const { settings, schedules, manualAway, lastEventId, lastEmailAt } = state;
    try {
      await AsyncStorage.setItem(PERSIST_KEY, JSON.stringify({ settings, schedules, manualAway, lastEventId, lastEmailAt }));
    } catch (e) {
      console.warn('No se pudo guardar el estado', e);
    }
  }, 300);
}

export async function hydrate() {
  if (state.hydrated) return;
  try {
    const raw = await AsyncStorage.getItem(PERSIST_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      state = {
        ...state,
        settings: { ...DEFAULT_SETTINGS, ...saved.settings },
        schedules: saved.schedules ?? [],
        manualAway: !!saved.manualAway,
        lastEventId: saved.lastEventId ?? 0,
        lastEmailAt: saved.lastEmailAt ?? 0,
      };
    }
  } catch (e) {
    console.warn('No se pudo leer el estado guardado', e);
  }
  setState({ hydrated: true });
}
