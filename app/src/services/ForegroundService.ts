/**
 * Servicio en primer plano (Android Foreground Service) + notificaciones.
 *
 * ¿Por qué? Android congela o mata procesos en segundo plano para ahorrar
 * batería. Un Foreground Service con notificación persistente le dice al
 * sistema "este proceso está haciendo trabajo visible para el usuario", lo
 * que mantiene vivo el hilo de JavaScript, el WebSocket y los temporizadores.
 *
 * Notifee ejecuta el "runner" como una Headless JS Task: mientras la promesa
 * no se resuelva, el servicio sigue activo y React Native sigue disparando
 * los timers (setTimeout/setInterval) aunque no haya Activity visible.
 */
import notifee, {
  AndroidForegroundServiceType,
  AndroidImportance,
  AndroidVisibility,
  AuthorizationStatus,
  EventType,
} from '@notifee/react-native';
import { PermissionsAndroid, Platform } from 'react-native';

export const CHANNEL_MONITOR = 'ids-monitor';
export const CHANNEL_ALERTS = 'ids-alerts';
const MONITOR_NOTIFICATION_ID = 'ids-monitor';
export const ACTION_STOP = 'stop-monitoring';

let resolveRunner: (() => void) | null = null;
let onStopRequested: (() => void) | null = null;

/** Se llama UNA vez en index.js, antes de registrar el componente raíz. */
export function registerForegroundRunner() {
  notifee.registerForegroundService(
    () =>
      new Promise<void>(resolve => {
        // El trabajo real lo hacen Monitor/Esp32Client (en este mismo hilo JS);
        // aquí solo mantenemos el servicio vivo hasta que se pida detenerlo.
        resolveRunner = resolve;
      }),
  );

  // Botón "Detener" de la notificación persistente (app en segundo plano o cerrada).
  notifee.onBackgroundEvent(async ({ type, detail }) => {
    if (type === EventType.ACTION_PRESS && detail.pressAction?.id === ACTION_STOP) {
      onStopRequested?.();
    }
  });
}

export function setStopHandler(fn: () => void) {
  onStopRequested = fn;
  return notifee.onForegroundEvent(({ type, detail }) => {
    if (type === EventType.ACTION_PRESS && detail.pressAction?.id === ACTION_STOP) fn();
  });
}

export async function setupNotifications(): Promise<boolean> {
  const settings = await notifee.requestPermission(); // POST_NOTIFICATIONS en Android 13+
  await notifee.createChannel({
    id: CHANNEL_MONITOR,
    name: 'Supervisión activa',
    importance: AndroidImportance.LOW, // silenciosa: solo indica que el servicio corre
  });
  await notifee.createChannel({
    id: CHANNEL_ALERTS,
    name: 'Alertas de intrusión',
    importance: AndroidImportance.HIGH,
    visibility: AndroidVisibility.PUBLIC,
    sound: 'default',
    vibration: true,
    vibrationPattern: [300, 500, 300, 500],
  });
  return settings.authorizationStatus >= AuthorizationStatus.AUTHORIZED;
}

async function hasCameraPermission() {
  if (Platform.OS !== 'android') return true;
  return PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CAMERA);
}

export async function showMonitorNotification(title: string, body: string) {
  // Android 14+ exige declarar el tipo de servicio. "camera" solo se puede usar
  // si el permiso ya fue concedido; si no, el sistema lanza SecurityException.
  const types = [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE];
  if (await hasCameraPermission()) types.push(AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_CAMERA);

  await notifee.displayNotification({
    id: MONITOR_NOTIFICATION_ID, // mismo id => se actualiza en lugar de crear otra
    title,
    body,
    android: {
      channelId: CHANNEL_MONITOR,
      asForegroundService: true,
      foregroundServiceTypes: types,
      ongoing: true,
      onlyAlertOnce: true,
      smallIcon: 'ic_launcher',
      pressAction: { id: 'default' },
      actions: [{ title: 'Detener', pressAction: { id: ACTION_STOP } }],
    },
  });
}

export async function stopMonitorService() {
  await notifee.stopForegroundService();
  resolveRunner?.();
  resolveRunner = null;
}

export async function notifyIntrusion(title: string, body: string) {
  await notifee.displayNotification({
    title,
    body,
    android: {
      channelId: CHANNEL_ALERTS,
      importance: AndroidImportance.HIGH,
      smallIcon: 'ic_launcher',
      pressAction: { id: 'default' },
    },
  });
}

export const openBatterySettings = () => notifee.openBatteryOptimizationSettings();
export const isBatteryOptimized = () => notifee.isBatteryOptimizationEnabled();
