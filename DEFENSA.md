# Guía de sustentación — Sistema de Detección de Intrusos IoT

El profesor hará 5 preguntas al azar, a personas específicas. **Cada integrante debe poder explicar todo**,
no solo "su parte". Esta guía sigue el orden en que viaja un evento:
cámara → análisis de imagen → app → ESP32 → red → correo.

Para cada pregunta: primero la respuesta corta (lo que debes decir de entrada), luego el detalle para las
contrapreguntas. Ensaya diciéndolo en voz alta con el código abierto.

---

## 0. La adaptación (díganla ustedes antes de que la pregunten)

**"No tienen ESP32-CAM ni sensores. ¿Qué hace cada parte?"**

> Repartimos responsabilidades según lo que cada dispositivo hace mejor. El celular tiene una cámara buena
> y un procesador potente: captura el video y hace el procesamiento de imagen para detectar movimiento. El
> ESP32 es el nodo central de la red: crea el punto de acceso, corre el servidor HTTP y WebSocket, valida
> y registra cada evento con su id y hora NTP, lo difunde a los clientes, guarda los últimos para que
> nadie pierda eventos tras un corte, e indica el estado con su LED.

Contrapregunta probable: *"¿Entonces el ESP32 no detecta nada?"*
> No detecta físicamente, pero sí aplica lógica local: valida cada reporte (rango de la puntuación),
> aplica limitación de tasa (máximo un evento cada 2 s), es la fuente de verdad de la numeración de eventos
> y de la hora, y mantiene el estado de armado. Si tuviéramos un sensor (PIR) o una ESP32-CAM, se conectaría
> al mismo `registerEvent()` sin cambiar nada de la app.

Contrapregunta: *"¿Y cómo sería el streaming con la ESP32-CAM?"* → sección 6 (MJPEG). Dominen eso.

---

## 1. Detección de movimiento por imagen

**¿Cómo detectan movimiento?** (pregunta casi segura)
> Con sustracción de fondo. La app mantiene un modelo del "fondo" (cómo se ve la escena vacía) y compara
> cada cuadro con él. Si una fracción suficiente de la imagen cambió, hay movimiento. Archivo:
> `src/vision/motionAnalysis.ts`.

Los 4 pasos, en orden:
1. **Submuestreo y luminancia**: de cada cuadro de 1280×720 (921 600 píxeles) tomamos una rejilla de
   64×48 = 3 072 puntos, y solo del plano **Y** (brillo) del formato YUV. El movimiento se ve en el brillo;
   el color no aporta y triplicaría los datos. Son 300 veces menos operaciones.
2. **Compensación global de brillo**: si se prende una luz o la cámara ajusta la exposición, *todos* los
   puntos cambian lo mismo. Calculamos el cambio medio y lo restamos, así no lo confundimos con movimiento.
   (Probado: +40 de brillo global da 0 % de cambio.)
3. **Diferencia con el fondo**: un punto "cambió" si difiere más de 25 niveles (de 0 a 255). Ese umbral
   está por encima del ruido del sensor. La **puntuación** es el % de puntos que cambiaron.
4. **Actualización del fondo** con media móvil exponencial: `fondo = fondo·0.9 + actual·0.1`. Absorbe
   cambios lentos (sombras que se mueven, nubes); un objeto que queda quieto se integra al fondo en ~2 s.

**¿Por qué comparan con un fondo y no con el cuadro anterior?**
> La diferencia entre cuadros consecutivos solo ve los bordes de lo que se mueve, y un movimiento lento
> casi no cambia entre dos cuadros seguidos. Contra el fondo se ve toda la silueta.

**¿Qué es la máquina de estados?** (`src/vision/MotionDetector.ts`)
> Convierte la puntuación de cada cuadro en eventos confiables:
> - **Calentamiento (3 s)**: al encender la cámara, la exposición y el balance de blancos cambian; se ignora.
> - **Confirmación**: hacen falta 2 cuadros seguidos sobre el umbral. Un pico aislado (parpadeo de una
>   lámpara, ruido) se descarta.
> - **Enfriamiento (10 s)**: tras un evento no se generan más por la misma persona.
> - **Oscuridad**: si el brillo medio es menor que 12, la imagen es puro ruido y no se evalúa.

**¿Dónde corre el procesamiento? ¿No congela la app?** (concurrencia)
> Corre en el **hilo de la cámara**, no en el de la interfaz. VisionCamera llama a un *frame processor*,
> que es un *worklet*: una función JavaScript que un plugin de Babel compila para ejecutarse en un runtime
> separado. Con `runAtTargetFps(5)` solo analizamos 5 de los ~30 cuadros por segundo; los demás se
> descartan. Al hilo de JS solo le llegan dos números por cuadro (puntuación y brillo) mediante
> `runOnJS`, y ahí corre la máquina de estados.

**¿Cómo se comparte el modelo de fondo entre cuadros?**
> Con un *shared value* de worklets-core: memoria compartida entre el runtime de la cámara y el de JS. Una
> variable normal no sirve porque cada ejecución del worklet recibe una copia de sus variables.

**¿Qué es `bytesPerRow` / el *stride*?**
> El hardware alinea cada fila de la imagen en memoria, así que una fila puede ocupar más bytes que su
> ancho (p. ej. 1280 píxeles en 1344 bytes). El píxel (x, y) está en `y·stride + x`. Lo calculamos como
> `tamaño del buffer / alto`. Si usáramos el ancho, la imagen leída saldría "torcida".

**¿Cuánto cuesta?**
> `toArrayBuffer()` copia el plano Y de la GPU a la CPU (~1 MB) 5 veces por segundo, y luego recorremos
> 3 072 puntos. Es poco para un celular moderno. Requiere Android 9+ (API de `HardwareBuffer`).

**Limitaciones (díganlas con honestidad si preguntan)**
> Ventanas, pantallas, cortinas o ventiladores en la escena causan falsos positivos; se mitiga apuntando
> bien y subiendo el umbral. Una persona que se mueve muy lento puede integrarse al fondo. Y como Android
> no permite usar la cámara en segundo plano, el celular debe quedar con la app abierta, como una cámara
> dedicada (la app mantiene la pantalla encendida).

**¿Cómo calibran?**
> El medidor bajo la cámara muestra en vivo el % de cambio y el umbral. Con la escena quieta debe quedar
> cerca de 0; al pasar una persona, muy por encima. Por eso los dos umbrales (área y píxel) son
> configurables.

---

## 2. El ESP32 y su red

**¿Qué hace el ESP32 cuando recibe un reporte?**
> `handleReport()`: valida que la puntuación esté entre 0.001 y 1, aplica limitación de tasa (si el último
> reporte fue hace menos de 2 s responde `nack`), y si pasa, `registerEvent()` le asigna id, hora NTP y
> estado de armado, lo guarda en el ring buffer, lo difunde a todos los clientes y responde `ack` al que
> reportó.

**¿El ESP32 tiene concurrencia? ¿Usaron mutex?**
> El firmware es un bucle no bloqueante: `loop()` atiende HTTP, WebSocket, latidos, Wi-Fi y LED, y todos
> los callbacks se ejecutan dentro de él. Como un solo hilo toca el estado (ring buffer, armado, sockets),
> no hay condiciones de carrera ni hace falta mutex. Es el mismo modelo de *event loop* que Node.js. El
> stack Wi-Fi sí corre en paralelo, en su propia tarea de FreeRTOS (núcleo 0), y se comunica con nosotros
> por eventos (`WiFi.onEvent`). El `delay(1)` cede la CPU al planificador.

**¿Por qué nada en `loop()` puede bloquear?**
> Si una función esperara (por ejemplo un `delay(5000)`), durante ese tiempo no se atenderían latidos ni
> reportes, la app creería que el ESP32 se cayó y saltaría el watchdog de tareas del sistema.

**¿Qué modo Wi-Fi usan y por qué?**
> `WIFI_AP_STA`: el ESP32 es punto de acceso (red "IDS-ESP32", IP 192.168.4.1) y a la vez cliente de otra red
> (el hotspot del celular). El AP garantiza acceso directo aunque no haya router; el STA da salida a internet
> (NTP para la hora) y deja al celular con datos móviles para enviar el correo.

Contrapregunta: *"¿En qué canal queda el AP?"* → el radio es uno solo, así que el AP se mueve al canal de la red
STA. `WiFi.setSleep(false)` desactiva el ahorro de energía del radio: más consumo, menos latencia.

**¿Qué protocolos y puertos usan?**
| Puerto | Protocolo | Uso |
|---|---|---|
| 80 | HTTP sobre TCP | `/status`, `/events`, `/arm` (consulta puntual, página web) |
| 81 | WebSocket sobre TCP | canal en tiempo real bidireccional |
| 465 | SMTP sobre TLS | del celular a Gmail |
| 123 | NTP sobre UDP | hora del ESP32 |
| 5353 | mDNS sobre UDP | `ids-esp32.local` |

**¿Por qué WebSocket y no HTTP con polling?**
> Con polling habría que preguntar cada X segundos: o hay retardo o se satura el ESP32. WebSocket abre
> **una** conexión TCP (empieza como HTTP con `Upgrade: websocket`) que queda abierta en ambos sentidos:
> cualquiera de los dos envía cuando quiere. Cabecera de 2–14 bytes por mensaje frente a cientos de HTTP.

**¿Por qué TCP y no UDP?**
> Una alerta no se puede perder ni desordenar: TCP garantiza entrega y orden. UDP sirve cuando lo viejo ya
> no importa (video en vivo, VoIP, NTP).

**¿Qué mensajes intercambian?** (JSON)
- App → ESP32: `report` (movimiento con su puntuación), `arm`, `sync`, `ping`, `test`, `status`.
- ESP32 → app: `hello` (al conectar), `hb` (latido cada 2 s), `state`, `motion`, `ack`/`nack`, `pong`, `error`.

**¿Qué es `enableHeartbeat(5000, 3000, 2)`?**
> Ping/pong del protocolo WebSocket: cada 5 s el ESP32 envía un *ping*; si el cliente no responde *pong*
> en 3 s dos veces, lo cierra. Libera conexiones "zombies"; el ESP32 tiene pocos sockets.

**¿Cómo se manejan los eventos perdidos durante una desconexión?**
> Cada evento tiene un id incremental y el ESP32 guarda los últimos 16 en un *ring buffer* (buffer circular).
> Al reconectar, la app envía `sync` con el último id que conoce y el ESP32 reenvía los posteriores. La app
> es **idempotente**: si un id ya se procesó, lo ignora. Si el ESP32 se reinicia (ids vuelven a 1), la app
> lo detecta en el `hello` y reinicia su contador.

**¿Y si el ESP32 está apagado cuando la cámara detecta algo?**
> La alerta no depende de la red: la app procesa el movimiento localmente (notificación, foto, correo) y en
> paralelo intenta reportarlo. Si no hay conexión, el correo lo dice ("Registrado en el ESP32: no").

---

## 3. App: conexión y reconexión

**¿Cómo detectan que se cayó la conexión?**
> De tres formas: (1) el evento `onclose`; (2) timeout de 5 s si el handshake no termina; (3) un
> **watchdog**: si pasan 7 s sin recibir nada (el ESP32 manda latidos cada 2 s), cerramos y reconectamos.

**¿Por qué el watchdog si ya existe `onclose`?**
> Por las conexiones TCP **medio abiertas**: si el ESP32 pierde la energía, nadie envía el FIN de TCP y el
> sistema operativo cree que la conexión sigue viva por minutos. Solo la falta de latidos lo revela.
> Probado en `tests/logic.test.ts` (reconecta a los ~7.5 s).

**¿Cómo reconectan?**
> Backoff exponencial con jitter: 0.5 s, 1 s, 2 s, 4 s… hasta 30 s, con una parte aleatoria (entre la mitad
> y el total). Exponencial para no gastar batería ni saturar al ESP32; aleatorio para que varios clientes
> no reconecten todos en el mismo instante. Al volver la app a primer plano se reconecta de inmediato.

**¿Qué pasa con los mensajes de un socket viejo?**
> Cada manejador compara `ws !== this.ws`; si el socket ya fue descartado, ignora sus eventos, y además se
> anulan sus handlers. Así un `onclose` tardío no tumba la conexión nueva.

**¿Cómo miden la latencia?**
> Cada 5 s la app envía `ping` con su `Date.now()`; el ESP32 lo devuelve en `pong` y la app calcula el RTT.
> Se usa el reloj del celular en ambos extremos, así no importa que los relojes no coincidan.

**¿Qué pasa con un JSON malformado?**
> La app lo descarta en un `try/catch` sin cerrar la conexión. El ESP32 responde `{"type":"error"}`.

---

## 4. App: segundo plano y concurrencia

**¿Qué es un Foreground Service y por qué lo usan?**
> Android congela o mata procesos que considera inactivos. Un Foreground Service, con su notificación
> **obligatoria y persistente**, le dice al sistema que la app hace trabajo visible para el usuario; así
> mantiene vivos el proceso, el WebSocket, los temporizadores y el envío de correos.

**Si la cámara no funciona en segundo plano, ¿para qué el servicio?**
> Para todo lo demás: que Android no mate el proceso mientras el celular vigila (por ejemplo con la pantalla
> atenuada o si alguien abre la cortina de notificaciones), que un correo en curso termine de enviarse
> aunque se salga de la app, y que la conexión con el ESP32 y la notificación persistente sigan activas.
> Si se sale de la app, la notificación sigue indicando el estado.

**¿Cómo sigue corriendo el JavaScript sin pantalla?**
> Notifee registra el servicio como una *Headless JS Task*. Mientras la promesa del *runner* no se resuelva,
> React Native mantiene el hilo JS activo y sigue disparando `setTimeout/setInterval`.

**¿Qué exige Android 14 para Foreground Services?**
> Declarar el **tipo**: usamos `camera` y `connectedDevice`, con sus permisos
> `FOREGROUND_SERVICE_CAMERA` y `FOREGROUND_SERVICE_CONNECTED_DEVICE`. El tipo `camera` solo se puede usar si
> el permiso de cámara ya fue concedido; si no, Android lanza `SecurityException`. El código lo verifica.

**¿Cuántos hilos hay en la app?**
> - Hilo de la cámara: captura y corre el frame processor (worklet).
> - Hilo de JS: máquina de estados, WebSocket, lógica de alertas. Es uno solo, pero no se bloquea: lo lento
>   (sockets, disco, cámara) ocurre en hilos nativos y vuelve por callbacks/promesas (event loop).
> - Hilo de UI (nativo): dibuja la interfaz.

**¿Y si llegan dos detecciones mientras se envía un correo?**
> La cola de correo procesa **un envío a la vez**. Además el antispam deja pasar como máximo un correo cada
> 60 s; los eventos intermedios se cuentan y se informan en el siguiente ("eventos agrupados").

**¿Qué permisos pide la app?**
> Cámara y notificaciones (en tiempo de ejecución); en el manifest: internet, foreground service y sus tipos,
> estado de red/wifi, wake lock y excluir de optimización de batería. `usesCleartextTraffic="true"` porque
> `ws://` y `http://` hacia el ESP32 no van cifrados (Android 9+ los bloquea por defecto).
> Con Expo, el AndroidManifest se genera en cada compilación: los permisos van en `app.json` y los tipos del
> servicio los agrega nuestro plugin `plugins/withForegroundService.js`.

**¿Por qué Expo con *development build* y no Expo Go?**
> Expo Go es una app ya compilada con un conjunto fijo de módulos nativos. Necesitamos módulos que no trae
> (VisionCamera con frame processors, Notifee y el socket TLS), así que compilamos nuestra propia versión
> con EAS Build en la nube. Seguimos usando el flujo de Expo (QR, recarga en caliente) pero con nuestros
> módulos nativos.

**Contrapregunta: "¿Eso no es inseguro?"**
> Sí: en la red local alguien podría leer los mensajes o enviar `arm:false`. Mejoras: WSS (TLS) en el ESP32
> o un token compartido. Las credenciales de Gmail sí viajan cifradas (TLS al 465).

---

## 5. Franjas horarias y correo

**¿Cómo decide la app si el sistema está armado?**
> Armado = "Fuera de casa" activado **o** alguna franja activa ahora. La app decide (tiene la hora y la
> configuración); se reevalúa cada 15 s y se envía `arm` al ESP32 para su LED. Con el sistema desarmado la
> detección sigue funcionando (sirve para calibrar), pero no genera alertas.

**¿Cómo funciona una franja que cruza la medianoche (22:00–06:00)?**
> Si la hora final es menor que la inicial, la franja está activa si (hoy está marcado y hora ≥ inicio) o
> (ayer está marcado y hora < fin). El día marcado es el día en que **empieza**: el lunes a las 02:00
> pertenece a la franja del domingo. Cubierto en las pruebas.

**¿Cómo se envía el correo?**
> La app habla el protocolo SMTP directamente sobre un socket TCP con TLS al puerto 465 de smtp.gmail.com:
> `EHLO` → `AUTH LOGIN` (usuario y contraseña en base64, protegidos por TLS) → `MAIL FROM` → `RCPT TO` →
> `DATA` → mensaje MIME → `.` → `QUIT`. Códigos esperados: 220, 250, 334, 235, 354, 250, 221.

Contrapreguntas:
- *¿465 vs 587?* → 465 = TLS desde el primer byte (implícito). 587 = conexión en claro que se cifra con
  `STARTTLS`.
- *¿Contraseña de aplicación?* → Google no acepta la contraseña normal en clientes SMTP; con verificación en
  2 pasos se genera una clave de 16 caracteres, revocable, solo para esta app.
- *¿Cómo leen respuestas que llegan partidas?* → TCP es un flujo de bytes, no de mensajes: se acumula en un
  búfer y se corta por `\r\n`. Una respuesta multilínea usa `250-` en las líneas intermedias y `250 ` en la
  última.
- *¿Cómo va la foto?* → MIME `multipart/mixed`: texto (plano + HTML) y una parte `image/jpeg` en base64 en
  líneas de 76 caracteres. El asunto con tildes/emoji va como `=?UTF-8?B?…?=`.
- *¿Dot-stuffing?* → En DATA, una línea con solo `.` termina el mensaje; por eso toda línea que empiece con
  `.` se duplica.
- *¿Y si no hay internet?* → Cola con 3 reintentos (5 s, 20 s, 60 s). Errores 5xx (p. ej. 535) son
  permanentes y no se reintentan.

---

## 6. Video y búfer (la rúbrica menciona "optimización del búfer de video")

**En nuestra solución:**
- La vista previa la dibuja la GPU directo desde la cámara; no pasa por la red, latencia ≈ 0.
- Formato 1280×720 a 30 fps: suficiente para detectar y para la foto, con menos memoria que 4K.
- **No encolamos cuadros**: `runAtTargetFps(5)` descarta los que no se analizan. Si el análisis tardara más
  que el intervalo entre cuadros, VisionCamera descarta cuadros en lugar de acumularlos, así la detección
  siempre trabaja con la imagen más reciente.
- La evidencia usa `takeSnapshot` (un cuadro de la vista previa, JPEG calidad 70): rápido y de ~100–200 KB, en
  vez de una foto a resolución completa de varios MB.

**Cómo sería con ESP32-CAM (MJPEG), para las contrapreguntas:**
- **MJPEG sobre HTTP**: el servidor responde `Content-Type: multipart/x-mixed-replace; boundary=frame` y no
  cierra la conexión; envía un JPEG tras otro, cada uno con `--frame` y su `Content-Length`.
- **Latencia vs búfer**: en tiempo real se descartan cuadros viejos, no se encolan. En la ESP32-CAM:
  `fb_count = 2` (doble búfer en PSRAM: mientras se envía uno, se captura otro) y
  `grab_mode = CAMERA_GRAB_LATEST` (siempre el cuadro más nuevo). Encolar haría crecer la latencia sin
  límite cuando la red es más lenta que la cámara.
- **Ajustes**: menor resolución (VGA/QVGA) y mayor `jpeg_quality` (número mayor = más compresión) reducen
  bytes por cuadro.
- **MJPEG vs WebSocket binario**: MJPEG es simple y lo abre cualquier navegador; WebSocket permite mezclar
  video y comandos en un solo canal y controlar el ritmo de envío.

---

## 7. Preguntas "trampa" frecuentes

| Pregunta | Respuesta corta |
|---|---|
| ¿Qué pasa si se va la luz del ESP32? | La detección y el correo siguen (son locales en el celular). El watchdog nota la caída en ~7 s, la app reintenta con backoff y al volver se resincroniza. |
| ¿Qué pasa si se cae el Wi-Fi? | Igual: reconexión automática; el correo usa los datos móviles si el celular los tiene. |
| ¿Qué pasa si apagan la luz del cuarto? | El brillo medio baja de 12 y el detector pasa a "Muy oscuro". El cambio brusco de luz no dispara gracias a la compensación de brillo. |
| ¿Detecta a una mascota? | Sí, si ocupa más del umbral de área. Se ajusta subiendo el umbral o apuntando más alto. |
| ¿Por qué 5 fps y no 30? | Una persona tarda más de 1 s en cruzar; 5 análisis por segundo bastan y gastan 6 veces menos batería. |
| ¿Por qué 2 cuadros de confirmación? | Un solo cuadro puede ser ruido o un parpadeo; 2 seguidos (0.4 s) filtran eso sin retrasar la alerta. |
| ¿Dónde se guarda la contraseña? | En AsyncStorage (almacenamiento privado de la app). Mejora: Android Keystore. |
| ¿Cuántos clientes soporta el ESP32? | El AP admite 4 estaciones; la librería WebSockets, 5 clientes por defecto. |
| ¿Cómo prueban sin moverse? | Botón *Simular intrusión* → comando `test` → el ESP32 genera un evento `SIM` que recorre todo el flujo de alerta. |
| ¿Qué es el RSSI? | Potencia de la señal recibida en dBm. −50 excelente, −70 aceptable, −85 malo. |

---

## 8. Reparto sugerido para estudiar (pero TODOS deben poder responder todo)

1. Procesamiento de imagen (sección 1) — abrir `motionAnalysis.ts` y `MotionDetector.ts`.
2. ESP32 y red (sección 2) — abrir `ids_esp32.ino`.
3. Conexión y reconexión (sección 3) — abrir `Esp32Client.ts` y correr los tests.
4. Segundo plano y concurrencia (sección 4) — `ForegroundService.ts`, `useMotionFrameProcessor.ts`, manifest.
5. Horarios, correo y video (secciones 5 y 6).

Ejercicio: cada uno explica el recorrido completo de un evento, desde que alguien entra en la imagen hasta que
llega el correo, en menos de 2 minutos y sin mirar.
