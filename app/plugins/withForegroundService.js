/**
 * Plugin de configuración de Expo (se ejecuta al compilar, no en el celular).
 *
 * Android 14+ exige que cada Foreground Service declare en el AndroidManifest
 * qué tipo de trabajo hace. Notifee declara su servicio sin esos tipos, así que
 * este plugin lo sobrescribe con:
 *   - camera          -> la vigilancia usa la cámara
 *   - connectedDevice -> mantiene la conexión con el ESP32
 *
 * En un proyecto sin Expo esto se haría editando a mano
 * android/app/src/main/AndroidManifest.xml; con Expo ese archivo se genera
 * en cada compilación, por eso el cambio se describe como código.
 */
const { withAndroidManifest } = require('expo/config-plugins');

const SERVICE_NAME = 'app.notifee.core.ForegroundService';
const SERVICE_TYPES = 'camera|connectedDevice';

module.exports = function withForegroundService(config) {
  return withAndroidManifest(config, cfg => {
    const manifest = cfg.modResults.manifest;
    manifest.$ = manifest.$ || {};
    manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';

    const app = manifest.application[0];
    app.service = app.service || [];

    let service = app.service.find(s => s.$['android:name'] === SERVICE_NAME);
    if (!service) {
      service = { $: { 'android:name': SERVICE_NAME } };
      app.service.push(service);
    }
    service.$['android:foregroundServiceType'] = SERVICE_TYPES;
    service.$['tools:replace'] = 'android:foregroundServiceType';
    return cfg;
  });
};
