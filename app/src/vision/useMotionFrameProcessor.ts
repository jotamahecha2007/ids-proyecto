/**
 * Conecta la cámara con el análisis de movimiento.
 *
 * Hilos involucrados:
 *  - Hilo de la cámara (nativo): entrega cada cuadro a ~30 fps al "frame
 *    processor". El frame processor es un worklet: JavaScript que corre en
 *    un runtime separado, en ese mismo hilo, sin bloquear la interfaz.
 *  - runAtTargetFps(5): solo 5 de cada ~30 cuadros se analizan; el resto se
 *    descarta. Analizar todos gastaría batería sin mejorar la detección.
 *  - Hilo de JS: recibe solo dos números por cuadro (puntuación y brillo)
 *    mediante runOnJS, y ahí corre la máquina de estados.
 *
 * El modelo de fondo vive en un "shared value", memoria compartida entre el
 * runtime de la cámara y el de JS, para que persista entre cuadros.
 */
import { useEffect, useMemo, useRef } from 'react';
import { runAtTargetFps, useFrameProcessor } from 'react-native-vision-camera';
import { useSharedValue, Worklets } from 'react-native-worklets-core';
import { analyzeLuma } from './motionAnalysis';
import { DEFAULT_DETECTOR, DetectorOutput, MotionDetector } from './MotionDetector';

const ANALYSIS_FPS = 5;
const BACKGROUND_ALPHA = 0.1;

export interface MotionOptions {
  enabled: boolean;          // false = cámara inactiva (se reinicia el calentamiento)
  areaThreshold: number;     // 0..1
  pixelThreshold: number;    // 0..255
  resetKey: unknown;         // cambia al voltear la cámara => se descarta el fondo
  onFrame: (score: number, brightness: number, out: DetectorOutput) => void;
  onMotion: (peakScore: number) => void;
}

export function useMotionFrameProcessor(opts: MotionOptions) {
  const background = useSharedValue<number[]>([]);
  const pixelThreshold = useSharedValue(opts.pixelThreshold);
  const detector = useMemo(() => new MotionDetector({ ...DEFAULT_DETECTOR }), []);

  // Las funciones de React cambian en cada render; se guardan en una ref para
  // que el callback creado una sola vez siempre llame a la versión actual.
  const cb = useRef(opts);
  cb.current = opts;

  useEffect(() => {
    pixelThreshold.value = opts.pixelThreshold;
  }, [opts.pixelThreshold, pixelThreshold]);

  useEffect(() => {
    detector.config = { ...detector.config, areaThreshold: opts.areaThreshold };
  }, [opts.areaThreshold, detector]);

  useEffect(() => {
    // Cámara nueva o reactivada: fondo vacío y periodo de calentamiento.
    background.value = [];
    detector.reset(Date.now());
  }, [opts.enabled, opts.resetKey, background, detector]);

  const onResult = useMemo(
    () =>
      Worklets.createRunOnJS((score: number, brightness: number) => {
        const out = detector.feed(score, brightness, Date.now());
        cb.current.onFrame(score, brightness, out);
        if (out.fired) cb.current.onMotion(out.peakScore);
      }),
    [detector],
  );

  return useFrameProcessor(
    frame => {
      'worklet';
      runAtTargetFps(ANALYSIS_FPS, () => {
        'worklet';
        if (frame.pixelFormat !== 'yuv') return;
        // En Android, toArrayBuffer() copia de la GPU el plano Y (luminancia):
        // `height` filas de `stride` bytes (stride ≥ width por alineación de memoria).
        const luma = new Uint8Array(frame.toArrayBuffer());
        const stride = Math.floor(luma.length / frame.height);
        if (stride < frame.width) return;
        const r = analyzeLuma(
          luma,
          frame.width,
          frame.height,
          stride,
          background.value,
          pixelThreshold.value,
          BACKGROUND_ALPHA,
        );
        background.value = r.background;
        onResult(r.score, r.brightness);
      });
    },
    [background, pixelThreshold, onResult],
  );
}
