# Sistema de Detección de Intrusos IoT — ESP32 + App móvil (Expo / React Native)

Versión **sin ESP32-CAM y sin sensores**: solo un ESP32 normal y un celular Android.

- La **cámara del celular** vigila la escena y detecta movimiento analizando la imagen
  (sustracción de fondo sobre la luminancia, en el hilo de la cámara).
- El **ESP32** es el nodo central de red: punto de acceso + servidor HTTP/WebSocket, valida y registra
  cada evento (id, hora NTP), lo difunde, guarda los últimos para resincronizar e indica el estado con su LED.
- La **app** (Expo SDK 54 / React Native 0.81) decide si el sistema está armado (horarios / "Fuera de casa"),
  notifica y envía el correo con la foto por SMTP/TLS a Gmail.
- La app se compila **en la nube con EAS Build**: no hace falta Android Studio, el SDK de Android ni Java.

```
          Celular (app Expo)                                       ESP32 (servidor)
 ┌─────────────────────────────────────────┐   WebSocket :81   ┌──────────────────────────┐
 │ Cámara ─► frame processor (5 fps)        │   report ──────►  │ valida (rango, tasa)     │
 │   plano Y ─► rejilla 64×48 ─► fondo      │  ◄────── ack/motion│ registra id + hora NTP   │
 │   ─► % de imagen que cambió              │  ◄── hello/hb/state│ ring buffer (16 eventos) │
 │ Máquina de estados (confirmar/enfriar)   │   arm/sync/ping ─► │ LED de estado            │
 │ ¿Armado? ─► notificación ─► foto ─► SMTP ├──► smtp.gmail.com  │ HTTP :80 /status /events │
 │ Foreground Service + notif. persistente  │                   │ AP "IDS-ESP32" + STA     │
 └─────────────────────────────────────────┘                   └──────────────────────────┘
```

| Requisito del enunciado | Cómo se cumple |
|---|---|
| ESP32 como servidor autónomo AP/router | `WIFI_AP_STA`: AP propio (192.168.4.1) + cliente de la red. HTTP :80 y WebSocket :81 |
| Captura de video | Cámara del celular a 30 fps con vista en vivo (sin latencia de red) |
| Detección: "procesamiento básico de imagen" | Sustracción de fondo con media móvil, compensación de brillo y máquina de estados |
| Visor con reconexión automática | WebSocket con timeout, watchdog de latidos, backoff exponencial con jitter y resincronización |
| Foreground Service + notificación persistente | Notifee (`asForegroundService`, tipos `camera` y `connectedDevice` para Android 14+) |
| Franjas horarias y "Fuera de casa" | Pantalla *Horarios*; soporta franjas que cruzan medianoche |
| Correo con evidencia | Cliente SMTP propio sobre TLS (Gmail), foto adjunta, cola con reintentos |

**Requisito importante:** el celular funciona como cámara de seguridad. Debe quedar **con la app abierta en la
pantalla Monitor**, fijo y **conectado al cargador**. Android no entrega la cámara a apps en segundo plano. La app
mantiene la pantalla encendida sola. Necesita **Android 9 o superior**.

**¿Por qué no Expo Go?** Expo Go trae un conjunto fijo de módulos nativos y este proyecto necesita otros
(análisis de imagen en el hilo de la cámara, foreground service, socket TLS). Por eso se usa un
*development build*: una "Expo Go propia" con esos módulos, compilada una vez en la nube.

---

## Paso a paso

### Fase 1 — Instalar herramientas (una sola vez)

1. **Node.js LTS** (nodejs.org).
2. **Git** (git-scm.com). Opciones por defecto.
3. **Visual Studio Code** (code.visualstudio.com), para ver y editar el código.
4. **Arduino IDE 2** (arduino.cc). Si pregunta por drivers, acepta todos.
5. Crea una cuenta gratis en **expo.dev** (la usa EAS para compilar la app).
6. ✅ En una terminal nueva: `node --version` y `git --version` responden.

### Fase 2 — Cargar el firmware en el ESP32

No hay que conectar nada al ESP32: solo el cable USB.

1. Activa el **hotspot (zona Wi-Fi) del celular** y ponlo en **2.4 GHz** (opción "Banda AP" o "Compatibilidad";
   el ESP32 no ve redes de 5 GHz). Anota nombre y clave.
2. Abre `esp32/ids_esp32/config.h` y escribe el nombre y la clave del hotspot:
   ```cpp
   #define STA_SSID "NombreDeTuHotspot"
   #define STA_PASS "ClaveDeTuHotspot"
   ```
3. Arduino IDE → *Herramientas → Placa → Gestor de placas* → instala **esp32** de Espressif.
4. *Gestor de librerías* → instala **WebSockets** (Markus Sattler) y **ArduinoJson** (Benoit Blanchon).
5. Abre `ids_esp32.ino`. *Placa*: **ESP32 Dev Module**. Conecta el ESP32 y elige su *Puerto*.
   - Si no aparece el puerto: instala el driver **CP210x** o **CH340** (mira qué chip tiene tu placa junto al USB).
6. Pulsa **Subir**. Si se queda en "Connecting…", mantén presionado el botón **BOOT** hasta que empiece.
7. Abre el *Monitor Serie* a **115200** y presiona **EN/RST** en la placa.
   - ✅ Debes ver `[WIFI] STA conectada. IP: 192.168.x.x`. **Anota esa IP.**
   - El LED azul parpadea lento (1 s): está esperando a que la app se conecte.
8. En el navegador del celular abre `http://LA_IP/`.
   - ✅ Ves la página "IDS ESP32" con el estado.

### Fase 3 — Contraseña de aplicación de Gmail

1. myaccount.google.com → *Seguridad* → activa la **Verificación en 2 pasos**.
2. Entra a **myaccount.google.com/apppasswords**, crea una llamada "IDS" y copia las **16 letras**.

### Fase 4 — Compilar la app en la nube (EAS Build)

1. Abre una terminal **dentro de la carpeta `app`** del proyecto y ejecuta:
   ```bash
   npm install
   npx tsx tests/logic.test.ts
   ```
   ✅ Debe terminar con `14 pruebas OK`.
2. Instala la herramienta de EAS e inicia sesión con tu cuenta de expo.dev:
   ```bash
   npm install -g eas-cli
   eas login
   ```
3. EAS necesita que el proyecto esté en un repositorio Git:
   ```bash
   git init
   git add .
   git commit -m "Proyecto IDS"
   ```
   (Si Git pide nombre y correo: `git config --global user.name "Tu Nombre"` y
   `git config --global user.email "tu@correo.com"`, y repite el commit.)
4. Lanza la compilación de desarrollo:
   ```bash
   eas build -p android --profile development
   ```
   - Pregunta si crear el proyecto en Expo → **Y**.
   - Pregunta por el *Android keystore* → **Y** (lo genera EAS).
   - La compilación tarda unos 10–25 minutos (en el plan gratuito puede haber cola).
5. Al terminar muestra un **enlace y un QR**. Ábrelo **en el celular**, descarga el `.apk` e instálalo.
   Android pedirá permitir "instalar apps desconocidas" desde el navegador: acéptalo.
   - ✅ En el celular aparece la app **IDS Vigilancia**.

Esta compilación se hace **una sola vez**. Solo hay que repetirla si cambias dependencias nativas o `app.json`.

### Fase 5 — Ejecutar la app

1. Conecta **el computador al hotspot del celular** (así el celular, el PC y el ESP32 quedan en la misma red).
2. En la carpeta `app`:
   ```bash
   npx expo start --dev-client
   ```
   Aparece un QR en la terminal.
3. Abre **IDS Vigilancia** en el celular. Elige el servidor que aparece en la lista o escanea el QR.
   - Si no lo encuentra: detén con Ctrl+C y usa `npx expo start --dev-client --tunnel`.
4. ✅ Se carga la app con tres pestañas: Monitor, Horarios y Ajustes. Si cambias el código en el PC, la app se
   recarga sola.

### Fase 6 — Configurar la app

1. Acepta los permisos de **cámara** y **notificaciones**.
2. **Ajustes**: IP del ESP32, tu Gmail, la contraseña de aplicación y el destinatario → **Guardar** →
   **Enviar correo de prueba**. ✅ Llega el correo (revisa spam).
3. **Ajustes → Abrir ajustes de batería** → marca la app como **Sin restricciones**.

### Fase 7 — Calibrar y probar

1. Pon el celular fijo apuntando a la puerta o pasillo y conéctalo al cargador.
2. En **Monitor** mira el medidor bajo la cámara:
   - Escena quieta: el "cambio" debe quedar en 0–0.5 %, barra verde y lejos de la raya blanca (el umbral).
   - Al pasar alguien: debe subir bien por encima del umbral (barra roja).
   - Si hay falsas alarmas, sube el **umbral de área** en Ajustes (2 → 4 %). Si no detecta, bájalo (2 → 1 %).
3. **Iniciar supervisión**. ✅ "ESP32: connected", RTT en ms, notificación "Vigilancia IDS" y el LED del ESP32 deja
   de parpadear.
4. **Activar "Fuera de casa"**. ✅ El LED queda encendido fijo.
5. Camina frente a la cámara. ✅ El LED parpadea rápido, llega la notificación y luego el correo con la foto.
   - Entre detecciones hay una pausa de 10 s, y como máximo sale un correo por minuto (configurable).
6. Prueba de reconexión: desconecta el ESP32 del USB, espera ~10 s (la app muestra "reconnecting"), vuelve a
   conectarlo. ✅ Se reconecta solo.
7. Prueba de horarios: desactiva "Fuera de casa" y en **Horarios** crea una franja que incluya la hora actual.

### Fase 8 — Versión final para la sustentación

La versión de desarrollo necesita el PC encendido. Para la demo, compila una versión independiente:
```bash
eas build -p android --profile preview
```
Instala ese `.apk` en el celular: funciona sin computador.

---

## Estructura

```
esp32/ids_esp32/
  ids_esp32.ino        firmware: WiFi AP+STA, HTTP, WebSocket, registro y validación de eventos
  config.h             credenciales, pin del LED, límites
app/                   proyecto Expo
  app.json             nombre, permisos y plugins de compilación (minSdk 28, cleartext, cámara)
  eas.json             perfiles de compilación en la nube (development / preview)
  plugins/withForegroundService.js  declara los tipos del Foreground Service (Android 14+)
  babel.config.js      plugin de worklets (código que corre en el hilo de la cámara)
  index.js             registra el runner del Foreground Service y la app
  App.tsx              pestañas Monitor / Horarios / Ajustes
  src/vision/          análisis de imagen y máquina de estados de detección
  src/services/        WebSocket, orquestador, alertas, cámara, SMTP, correo, foreground service
  src/utils/           franjas horarias, construcción MIME
  tests/logic.test.ts  14 pruebas: horarios, imagen, SMTP, WebSocket
DEFENSA.md             guía para la sustentación
```

## Problemas comunes

| Síntoma | Causa / solución |
|---|---|
| Al abrir en **Expo Go** sale "native module not found" | Hay que usar la app **IDS Vigilancia** compilada con EAS, no Expo Go |
| `eas build` dice que no es un repositorio Git | Haz el paso 3 de la fase 4 (`git init`, `git add .`, `git commit`) |
| La app no encuentra el servidor de desarrollo | El PC no está en la misma red que el celular; conéctalo al hotspot o usa `--tunnel` |
| La app queda en "reconnecting" | IP del ESP32 equivocada o el ESP32 no está en el hotspot |
| El medidor se queda en 0 siempre | El celular tiene Android 8 o inferior (se requiere 9+) |
| Falsas alarmas | Sube el umbral de área; evita apuntar a ventanas, pantallas, cortinas o ventiladores |
| `535 Bad credentials` | Usa la contraseña de aplicación, no la normal |
| El ESP32 no se conecta al hotspot | El hotspot está en 5 GHz; cámbialo a 2.4 GHz |
