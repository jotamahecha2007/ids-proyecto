/**
 * Máquina de estados que convierte la puntuación de cada cuadro en eventos de
 * movimiento confirmados. Corre en el hilo de JS (barato: 5 llamadas por segundo).
 *
 *   CALENTANDO ──(warmupMs)──> REPOSO ──(score ≥ umbral)──> CANDIDATO
 *        CANDIDATO ──(confirmFrames cuadros seguidos)──> EVENTO ──> ENFRIAMIENTO
 *        CANDIDATO ──(un cuadro bajo el umbral)──> REPOSO   (era ruido)
 *        ENFRIAMIENTO ──(cooldownMs)──> REPOSO
 *
 * - Calentamiento: al encender la cámara, la exposición automática y el balance
 *   de blancos cambian durante unos segundos; se ignora ese periodo.
 * - Confirmación: un solo cuadro alto puede ser ruido del sensor o un parpadeo
 *   de la luz; se exigen varios cuadros consecutivos.
 * - Enfriamiento: evita disparar decenas de eventos por la misma persona.
 */

export interface DetectorConfig {
  areaThreshold: number;  // fracción de la imagen que debe cambiar (0.02 = 2 %)
  confirmFrames: number;  // cuadros consecutivos sobre el umbral
  cooldownMs: number;
  warmupMs: number;
  minBrightness: number;  // por debajo, la imagen es demasiado oscura para confiar
}

export const DEFAULT_DETECTOR: DetectorConfig = {
  areaThreshold: 0.02,
  confirmFrames: 2,
  cooldownMs: 10000,
  warmupMs: 3000,
  minBrightness: 12,
};

export type DetectorState = 'warmup' | 'idle' | 'candidate' | 'cooldown' | 'dark';

export interface DetectorOutput {
  state: DetectorState;
  fired: boolean;
  peakScore: number; // mayor puntuación durante la confirmación
}

export class MotionDetector {
  private startedAt = 0;
  private hits = 0;
  private peak = 0;
  private lastEventAt = -Infinity;

  constructor(public config: DetectorConfig = DEFAULT_DETECTOR) {}

  /** Llamar cuando la cámara (re)arranca o cambia de lente. */
  reset(now: number) {
    this.startedAt = now;
    this.hits = 0;
    this.peak = 0;
  }

  feed(score: number, brightness: number, now: number): DetectorOutput {
    const c = this.config;
    if (now - this.startedAt < c.warmupMs) return { state: 'warmup', fired: false, peakScore: 0 };
    if (brightness < c.minBrightness) { this.hits = 0; return { state: 'dark', fired: false, peakScore: 0 }; }
    if (now - this.lastEventAt < c.cooldownMs) return { state: 'cooldown', fired: false, peakScore: 0 };

    if (score < c.areaThreshold) {
      this.hits = 0;
      this.peak = 0;
      return { state: 'idle', fired: false, peakScore: 0 };
    }

    this.hits++;
    this.peak = Math.max(this.peak, score);
    if (this.hits < c.confirmFrames) return { state: 'candidate', fired: false, peakScore: this.peak };

    const peakScore = this.peak;
    this.lastEventAt = now;
    this.hits = 0;
    this.peak = 0;
    return { state: 'cooldown', fired: true, peakScore };
  }
}
