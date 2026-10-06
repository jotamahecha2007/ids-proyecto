/**
 * Punto de entrada. El runner del Foreground Service se registra ANTES que el
 * componente raíz, porque Android puede arrancar el servicio sin abrir la UI.
 */
import { registerRootComponent } from 'expo';
import App from './App';
import { registerForegroundRunner } from './src/services/ForegroundService';

registerForegroundRunner();
registerRootComponent(App);
