/**
 * Análisis de movimiento por imagen (sustracción de fondo sobre la luminancia).
 *
 * Se ejecuta como "worklet" en el hilo de la cámara (no en el hilo de JS), unas
 * 5 veces por segundo. Es una función pura: recibe el cuadro y el modelo de
 * fondo anterior, devuelve la puntuación y el nuevo modelo. Así se puede probar
 * en Node.js sin teléfono.
 *
 * Pasos:
 *  1. Submuestreo: en vez de 921 600 píxeles (1280×720) se toma una rejilla de
 *     64×48 = 3 072 puntos. Basta para detectar a una persona y es 300 veces
 *     menos trabajo. Solo se lee el plano Y (luminancia) del formato YUV:
 *     el movimiento se ve en el brillo, el color no hace falta.
 *  2. Compensación global de brillo: si la cámara ajusta la exposición o se
 *     prende una luz, TODOS los puntos cambian lo mismo. Se resta ese cambio
 *     medio para no confundirlo con movimiento.
 *  3. Diferencia con el fondo: un punto "cambió" si difiere del fondo más que
 *     `pixelThreshold` niveles (de 0 a 255). La puntuación es la fracción de
 *     puntos que cambiaron (0 = nada, 1 = toda la imagen).
 *  4. Actualización del fondo con media móvil exponencial:
 *        fondo = fondo·(1−α) + actual·α
 *     El fondo absorbe cambios lentos (sombras, nubes) pero no movimientos
 *     rápidos. Con α = 0.1 a 5 fps, algo quieto se integra al fondo en ~2 s.
 */

export const GRID_W = 64;
export const GRID_H = 48;

export interface MotionResult {
  score: number;        // fracción de puntos que cambiaron (0..1)
  brightness: number;   // luminancia media del cuadro (0..255)
  background: number[]; // nuevo modelo de fondo
}

export function analyzeLuma(
  luma: Uint8Array,
  width: number,
  height: number,
  bytesPerRow: number,
  background: number[],
  pixelThreshold: number,
  alpha: number,
): MotionResult {
  'worklet';
  const n = GRID_W * GRID_H;
  const cur: number[] = new Array(n);
  let sum = 0;

  // 1. Submuestreo del plano Y. bytesPerRow (stride) puede ser mayor que el
  //    ancho porque el hardware alinea cada fila en memoria.
  for (let gy = 0; gy < GRID_H; gy++) {
    const y = Math.floor(((gy + 0.5) * height) / GRID_H);
    const row = y * bytesPerRow;
    for (let gx = 0; gx < GRID_W; gx++) {
      const x = Math.floor(((gx + 0.5) * width) / GRID_W);
      const v = luma[row + x];
      cur[gy * GRID_W + gx] = v;
      sum += v;
    }
  }
  const brightness = sum / n;

  // Primer cuadro: todavía no hay fondo con qué comparar.
  if (background.length !== n) return { score: 0, brightness, background: cur };

  // 2. Cambio global de brillo entre el fondo y el cuadro actual.
  let bgSum = 0;
  for (let i = 0; i < n; i++) bgSum += background[i];
  const shift = brightness - bgSum / n;

  // 3 y 4. Contar puntos que cambiaron y actualizar el fondo.
  let changed = 0;
  const next: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const diff = Math.abs(cur[i] - background[i] - shift);
    if (diff > pixelThreshold) changed++;
    next[i] = background[i] * (1 - alpha) + cur[i] * alpha;
  }

  return { score: changed / n, brightness, background: next };
}
