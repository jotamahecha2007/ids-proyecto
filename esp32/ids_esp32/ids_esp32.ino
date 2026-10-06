/*
 * =====================================================================
 *  IDS – Nodo central ESP32 (Sistema de Detección de Intrusos IoT)
 * =====================================================================
 *  Rol: servidor autónomo en modo AP + STA. La detección de movimiento la
 *  hace la cámara del celular (análisis de imagen); el ESP32:
 *    - valida y registra cada evento reportado (id, hora NTP, armado),
 *    - lo difunde a todos los clientes conectados,
 *    - guarda los últimos eventos para que la app recupere los perdidos,
 *    - indica el estado con su LED,
 *    - expone una API HTTP para consultar estado y eventos.
 *
 *    HTTP  :80  -> página de estado, /status, /events, /arm
 *    WS    :81  -> canal bidireccional (reportes, eventos, latidos, armado,
 *                  ping/pong, resincronización)
 *
 *  Modelo de ejecución: un solo bucle (loop) no bloqueante. Todos los
 *  callbacks de HTTP y WebSocket se ejecutan dentro de loop(), así que el
 *  estado global solo lo toca un hilo y no necesita mutex. El stack Wi-Fi
 *  corre aparte, en su propia tarea de FreeRTOS en el núcleo 0.
 *
 *  Librerías (Gestor de librerías de Arduino):
 *    - "WebSockets" de Markus Sattler  (>= 2.4)
 *    - "ArduinoJson" de Benoit Blanchon (>= 7)
 *  Placa: "ESP32 Dev Module" (core arduino-esp32 3.x)
 * =====================================================================
 */
#include <WiFi.h>
#include <WebServer.h>
#include <WebSocketsServer.h>
#include <ArduinoJson.h>
#include <ESPmDNS.h>
#include <time.h>
#include "config.h"

// ---------------------------------------------------------------------
//  Tipos
// ---------------------------------------------------------------------
enum class EventSource : uint8_t { CAMERA, SIMULATED };

struct MotionEvent {           // evento numerado, guardado en el ring buffer
  uint32_t    id;
  uint32_t    uptimeMs;
  time_t      epoch;           // 0 si todavía no hay hora NTP
  float       score;           // fracción de la imagen que cambió (0..1)
  EventSource source;
  bool        armed;           // estado de armado en el ESP32 al ocurrir
  uint32_t    reporterIp;      // quién lo reportó
};

// ---------------------------------------------------------------------
//  Estado global (solo lo toca loop())
// ---------------------------------------------------------------------
static WebServer        http(HTTP_PORT);
static WebSocketsServer ws(WS_PORT);

static bool        g_armed         = false;
static uint32_t    g_nextId        = 1;
static MotionEvent g_ring[EVENT_RING_SIZE];
static uint8_t     g_ringHead      = 0;   // posición donde se escribe el próximo
static uint8_t     g_ringCount     = 0;
static uint32_t    g_lastReportMs  = 0;
static uint32_t    g_rejected      = 0;   // reportes descartados por validación
static uint32_t    g_lastHbMs      = 0;
static uint32_t    g_lastWifiTry   = 0;
static uint32_t    g_ledFlashUntil = 0;
static bool        g_ntpStarted    = false;

// ---------------------------------------------------------------------
//  Utilidades
// ---------------------------------------------------------------------
static bool timeIsValid() { return time(nullptr) > 1700000000; }  // > nov-2023

static String isoTime(time_t t) {
  if (t == 0) return "";
  struct tm tmv;
  localtime_r(&t, &tmv);
  char buf[32];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S-05:00", &tmv);
  return String(buf);
}

static const char* sourceName(EventSource s) { return s == EventSource::CAMERA ? "CAMERA" : "SIM"; }

static void eventToJson(const MotionEvent& e, JsonObject o) {
  o["type"]      = "motion";
  o["id"]        = e.id;
  o["uptime"]    = e.uptimeMs;
  o["epoch"]     = (uint32_t)e.epoch;
  o["iso"]       = isoTime(e.epoch);
  o["score"]     = e.score;
  o["sensor"]    = sourceName(e.source);
  o["simulated"] = e.source == EventSource::SIMULATED;
  o["armed"]     = e.armed;
  o["from"]      = IPAddress(e.reporterIp).toString();
}

static void wsSendJson(int8_t client, JsonDocument& doc) {
  String out;
  serializeJson(doc, out);
  if (client < 0) ws.broadcastTXT(out);
  else            ws.sendTXT((uint8_t)client, out);
}

static void wsSendError(uint8_t client, const String& msg) {
  JsonDocument doc;
  doc["type"]  = "error";
  doc["error"] = msg;
  wsSendJson(client, doc);
}

static uint32_t lastEventId() { return g_nextId - 1; }

// ---------------------------------------------------------------------
//  Registro de eventos
// ---------------------------------------------------------------------
static const MotionEvent& registerEvent(EventSource src, float score, uint32_t reporterIp) {
  MotionEvent e;
  e.id         = g_nextId++;
  e.uptimeMs   = millis();
  e.epoch      = timeIsValid() ? time(nullptr) : 0;
  e.score      = score;
  e.source     = src;
  e.armed      = g_armed;
  e.reporterIp = reporterIp;

  g_ring[g_ringHead] = e;
  const MotionEvent& stored = g_ring[g_ringHead];
  g_ringHead = (g_ringHead + 1) % EVENT_RING_SIZE;
  if (g_ringCount < EVENT_RING_SIZE) g_ringCount++;

  JsonDocument doc;
  eventToJson(stored, doc.to<JsonObject>());
  wsSendJson(-1, doc);   // difusión a todos los clientes

  g_ledFlashUntil = millis() + 1500;
  Serial.printf("[MOTION] id=%u src=%s score=%.3f armed=%d clients=%u\n",
                (unsigned)stored.id, sourceName(src), score, g_armed, (unsigned)ws.connectedClients());
  return stored;
}

// Valida un reporte de la app antes de aceptarlo:
//  - limitación de tasa: un cliente con errores no puede inundar el registro;
//  - rango de la puntuación: descarta datos corruptos o absurdos.
static void handleReport(uint8_t client, JsonDocument& in) {
  const uint32_t now = millis();
  const float score = in["score"] | -1.0f;

  if (score < REPORT_MIN_SCORE || score > REPORT_MAX_SCORE) {
    g_rejected++;
    wsSendError(client, "report: score fuera de rango");
    return;
  }
  if (g_lastReportMs != 0 && now - g_lastReportMs < REPORT_MIN_INTERVAL_MS) {
    g_rejected++;
    JsonDocument nack;
    nack["type"]   = "nack";
    nack["reason"] = "rate-limit";
    nack["t"]      = in["t"];
    wsSendJson(client, nack);
    return;
  }
  g_lastReportMs = now;

  const MotionEvent& e = registerEvent(EventSource::CAMERA, score, (uint32_t)ws.remoteIP(client));
  JsonDocument ack;                  // confirmación al que reportó
  ack["type"] = "ack";
  ack["id"]   = e.id;
  ack["t"]    = in["t"];
  wsSendJson(client, ack);
}

// Reenvía al cliente los eventos con id > lastId que siguen en el buffer.
static void replayEvents(uint8_t client, uint32_t lastId) {
  const uint8_t start = (g_ringHead + EVENT_RING_SIZE - g_ringCount) % EVENT_RING_SIZE;
  unsigned sent = 0;
  for (uint8_t i = 0; i < g_ringCount; i++) {
    const MotionEvent& e = g_ring[(start + i) % EVENT_RING_SIZE];
    if (e.id <= lastId) continue;
    JsonDocument doc;
    JsonObject o = doc.to<JsonObject>();
    eventToJson(e, o);
    o["replay"] = true;
    wsSendJson(client, doc);
    sent++;
  }
  Serial.printf("[WS] replay a #%u desde id>%u: %u eventos\n", client, (unsigned)lastId, sent);
}

// ---------------------------------------------------------------------
//  Mensajes de estado
// ---------------------------------------------------------------------
static void fillStatus(JsonObject o) {
  o["device"]     = DEVICE_ID;
  o["fw"]         = FW_VERSION;
  o["armed"]      = g_armed;
  o["lastId"]     = lastEventId();
  o["uptime"]     = millis();
  o["clients"]    = ws.connectedClients();
  o["rejected"]   = g_rejected;
  o["heap"]       = ESP.getFreeHeap();
  o["staIp"]      = WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : "";
  o["apIp"]       = WiFi.softAPIP().toString();
  o["rssi"]       = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;
  o["timeSynced"] = timeIsValid();
  o["iso"]        = timeIsValid() ? isoTime(time(nullptr)) : "";
}

static void sendState(int8_t client, const char* type) {
  JsonDocument doc;
  JsonObject o = doc.to<JsonObject>();
  o["type"] = type;
  fillStatus(o);
  wsSendJson(client, doc);
}

static void setArmed(bool armed, const char* origin) {
  if (g_armed == armed) return;
  g_armed = armed;
  Serial.printf("[ARM] %s (origen: %s)\n", armed ? "ARMADO" : "DESARMADO", origin);
  sendState(-1, "state");
}

// ---------------------------------------------------------------------
//  WebSocket
// ---------------------------------------------------------------------
static void handleCommand(uint8_t client, uint8_t* payload, size_t len) {
  JsonDocument in;
  DeserializationError err = deserializeJson(in, payload, len);
  if (err) {
    wsSendError(client, String("JSON inválido: ") + err.c_str());
    return;
  }

  const char* cmd = in["cmd"] | "";

  if (strcmp(cmd, "ping") == 0) {                 // medición de latencia (RTT)
    JsonDocument doc;
    doc["type"] = "pong";
    doc["t"]    = in["t"];                         // eco del timestamp de la app
    wsSendJson(client, doc);

  } else if (strcmp(cmd, "report") == 0) {        // la cámara detectó movimiento
    handleReport(client, in);

  } else if (strcmp(cmd, "arm") == 0) {
    setArmed(in["value"] | false, "app");

  } else if (strcmp(cmd, "sync") == 0) {          // la app reconectó: pide lo perdido
    replayEvents(client, in["lastId"] | 0);

  } else if (strcmp(cmd, "test") == 0) {          // evento simulado para demostración
    registerEvent(EventSource::SIMULATED, 0, (uint32_t)ws.remoteIP(client));

  } else if (strcmp(cmd, "status") == 0) {
    sendState(client, "state");

  } else {
    wsSendError(client, String("Comando desconocido: ") + cmd);
  }
}

static void onWsEvent(uint8_t client, WStype_t type, uint8_t* payload, size_t len) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.printf("[WS] cliente #%u conectado desde %s\n", client, ws.remoteIP(client).toString().c_str());
      sendState(client, "hello");
      break;
    case WStype_DISCONNECTED:
      Serial.printf("[WS] cliente #%u desconectado\n", client);
      break;
    case WStype_TEXT:
      handleCommand(client, payload, len);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------
//  HTTP
// ---------------------------------------------------------------------
static const char INDEX_HTML[] PROGMEM = R"HTML(<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>IDS ESP32</title><style>body{font-family:system-ui;margin:24px;background:#111;color:#eee}
pre{background:#222;padding:12px;border-radius:8px;white-space:pre-wrap}button{padding:10px 16px;margin-right:8px}</style></head>
<body><h2>IDS ESP32</h2><pre id="s">cargando…</pre>
<button onclick="arm(1)">Armar</button><button onclick="arm(0)">Desarmar</button>
<h3>Últimos eventos</h3><pre id="e"></pre>
<script>
async function load(){
 document.getElementById('s').textContent=JSON.stringify(await (await fetch('/status')).json(),null,2);
 const ev=await (await fetch('/events')).json();
 document.getElementById('e').textContent=ev.reverse().map(x=>'#'+x.id+' '+(x.iso||x.uptime+'ms')+' '+x.sensor+' '+(x.score*100).toFixed(1)+'%').join('\n')||'(ninguno)';
}
async function arm(v){await fetch('/arm?on='+v,{method:'POST'});load()}
load();setInterval(load,2000);
</script></body></html>)HTML";

static void addCors() {
  http.sendHeader("Access-Control-Allow-Origin", "*");
  http.sendHeader("Cache-Control", "no-store");
}

static void httpStatus() {
  JsonDocument doc;
  fillStatus(doc.to<JsonObject>());
  String out; serializeJson(doc, out);
  addCors();
  http.send(200, "application/json", out);
}

static void httpEvents() {
  JsonDocument doc;
  JsonArray arr = doc.to<JsonArray>();
  const uint8_t start = (g_ringHead + EVENT_RING_SIZE - g_ringCount) % EVENT_RING_SIZE;
  for (uint8_t i = 0; i < g_ringCount; i++) eventToJson(g_ring[(start + i) % EVENT_RING_SIZE], arr.add<JsonObject>());
  String out; serializeJson(doc, out);
  addCors();
  http.send(200, "application/json", out);
}

static void httpArm() {
  if (!http.hasArg("on")) { addCors(); http.send(400, "text/plain", "falta ?on=0|1"); return; }
  setArmed(http.arg("on") == "1", "http");
  httpStatus();
}

static void setupHttp() {
  http.on("/", HTTP_GET, [] { http.send_P(200, "text/html", INDEX_HTML); });
  http.on("/status", HTTP_GET, httpStatus);
  http.on("/events", HTTP_GET, httpEvents);
  http.on("/arm", HTTP_POST, httpArm);
  http.on("/arm", HTTP_GET, httpArm);
  http.onNotFound([] { addCors(); http.send(404, "text/plain", "no encontrado"); });
  http.begin();
}

// ---------------------------------------------------------------------
//  WiFi (AP + STA)
// ---------------------------------------------------------------------
static void onWifiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  switch (event) {
    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      Serial.printf("[WIFI] STA conectada. IP: %s  (canal %d)\n",
                    WiFi.localIP().toString().c_str(), (int)WiFi.channel());
      if (!g_ntpStarted) { configTzTime(TZ_POSIX, NTP_SERVER_1, NTP_SERVER_2); g_ntpStarted = true; }
      break;
    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      Serial.printf("[WIFI] STA desconectada (razón %d)\n", info.wifi_sta_disconnected.reason);
      break;
    case ARDUINO_EVENT_WIFI_AP_STACONNECTED:
      Serial.println("[WIFI] un dispositivo se unió al AP");
      break;
    default:
      break;
  }
}

static void setupWifi() {
  WiFi.onEvent(onWifiEvent);
  WiFi.mode(WIFI_AP_STA);
  WiFi.setSleep(false);   // sin ahorro de energía del radio => menor latencia
  WiFi.softAP(AP_SSID, AP_PASS, 1, 0, AP_MAX_CLIENTS);
  Serial.printf("[WIFI] AP '%s' activo en %s\n", AP_SSID, WiFi.softAPIP().toString().c_str());

  if (strlen(STA_SSID) > 0) {
    WiFi.setAutoReconnect(true);
    WiFi.begin(STA_SSID, STA_PASS);
    g_lastWifiTry = millis();
  }
  if (MDNS.begin(MDNS_NAME)) {
    MDNS.addService("http", "tcp", HTTP_PORT);
    MDNS.addService("ws", "tcp", WS_PORT);
  }
}

static void maintainWifi(uint32_t now) {
  if (strlen(STA_SSID) == 0) return;
  if (WiFi.status() != WL_CONNECTED && now - g_lastWifiTry >= WIFI_RETRY_MS) {
    g_lastWifiTry = now;
    Serial.println("[WIFI] reintentando STA…");
    WiFi.disconnect(false, false);
    WiFi.begin(STA_SSID, STA_PASS);
  }
}

// ---------------------------------------------------------------------
//  LED: fijo = armado · apagado = desarmado · parpadeo rápido = movimiento
//       parpadeo lento = ningún celular conectado
// ---------------------------------------------------------------------
static void updateLed(uint32_t now) {
  bool on;
  if (now < g_ledFlashUntil)            on = (now / 100) % 2;
  else if (ws.connectedClients() == 0)  on = (now / 1000) % 2;
  else                                  on = g_armed;
  digitalWrite(PIN_LED, on ? HIGH : LOW);
}

// ---------------------------------------------------------------------
//  setup / loop
// ---------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\n=== %s v%s ===\n", DEVICE_ID, FW_VERSION);
  pinMode(PIN_LED, OUTPUT);

  setupWifi();
  setupHttp();

  ws.begin();
  ws.onEvent(onWsEvent);
  // Ping/pong a nivel de protocolo WebSocket: cada 5 s; si no hay pong en
  // 3 s dos veces seguidas, el servidor cierra ese cliente "zombie".
  ws.enableHeartbeat(5000, 3000, 2);

  Serial.printf("[HTTP] http://%s/  |  WS ws://%s:%d/\n",
                WiFi.softAPIP().toString().c_str(), WiFi.softAPIP().toString().c_str(), WS_PORT);
}

void loop() {
  const uint32_t now = millis();

  http.handleClient();
  ws.loop();

  if (now - g_lastHbMs >= HEARTBEAT_MS) {   // latido de aplicación
    g_lastHbMs = now;
    sendState(-1, "hb");
  }

  maintainWifi(now);
  updateLed(now);
  delay(1);   // cede la CPU a otras tareas de FreeRTOS (y al watchdog)
}
