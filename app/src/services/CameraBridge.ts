/**
 * Puente entre el componente <Camera> (vive en la UI) y el servicio de alertas
 * (vive fuera de React y puede ejecutarse con la app en segundo plano).
 *
 * Android solo entrega imágenes de la cámara mientras la vista está activa.
 * Si la app está en segundo plano la captura falla o no responde: por eso
 * hay un timeout y la alerta se envía igual, con la marca temporal exacta
 * como evidencia (lo que el enunciado permite: "foto O marca temporal").
 */
import type { Camera } from 'react-native-vision-camera';

let camera: Camera | null = null;
let active = false;

export interface CapturedPhoto { base64: string; width: number; height: number; capturedAt: number }

export const cameraBridge = {
  attach(c: Camera | null) { camera = c; },
  setActive(a: boolean) { active = a; },
  get available() { return !!camera && active; },

  async capture(timeoutMs = 4000): Promise<CapturedPhoto | null> {
    if (!camera || !active) return null;
    const cam = camera;
    const work = (async () => {
      const capturedAt = Date.now();
      let path: string;
      let width = 0;
      let height = 0;
      try {
        // takeSnapshot toma el cuadro de la vista previa: rápido y liviano (ideal para correo).
        const snap = await cam.takeSnapshot({ quality: 70 });
        ({ path, width, height } = snap);
      } catch {
        const photo = await cam.takePhoto({ flash: 'off', enableShutterSound: false });
        ({ path, width, height } = photo);
      }
      const base64 = await fileToBase64(path);
      return { base64, width, height, capturedAt };
    })();

    try {
      return await Promise.race([
        work,
        new Promise<null>(r => setTimeout(() => r(null), timeoutMs)),
      ]);
    } catch (e) {
      console.warn('Captura fallida', e);
      return null;
    }
  },
};

/** Lee un archivo local como base64 sin librerías nativas extra (fetch + FileReader). */
async function fileToBase64(path: string): Promise<string> {
  const uri = path.startsWith('file://') ? path : `file://${path}`;
  const blob = await (await fetch(uri)).blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onloadend = () => {
      const dataUrl = String(reader.result);
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1)); // quita "data:image/jpeg;base64,"
    };
    reader.readAsDataURL(blob);
  });
}
