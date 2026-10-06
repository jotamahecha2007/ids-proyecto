#pragma once
// =====================================================================
//  Configuración del nodo ESP32 (edita estos valores antes de flashear)
// =====================================================================

// --- Red a la que se conecta el ESP32 (modo STA). Recomendado: el hotspot
//     del celular, en 2.4 GHz. Déjala vacía ("") para trabajar solo en modo AP.
#define STA_SSID        "S22 Ultra de jota_mahecha"
#define STA_PASS        "simelochupaledigo"

// --- Punto de acceso propio del ESP32 (modo AP). IP fija: 192.168.4.1
#define AP_SSID         "IDS-ESP32"
#define AP_PASS         "intrusos123"   // mínimo 8 caracteres (WPA2)
#define AP_MAX_CLIENTS  4

#define MDNS_NAME       "ids-esp32"     // http://ids-esp32.local
#define DEVICE_ID       "ids-esp32"
#define FW_VERSION      "2.0.0"

// --- Pines. En la mayoría de placas ESP32 DevKit el LED azul integrado está en GPIO 2.
#define PIN_LED         2

// --- Validación de reportes de movimiento
#define REPORT_MIN_INTERVAL_MS  2000UL  // limitación de tasa: ignora reportes más seguidos
#define REPORT_MIN_SCORE        0.001f  // descarta reportes sin cambio real en la imagen
#define REPORT_MAX_SCORE        1.0f

// --- Red / protocolo
#define HTTP_PORT              80
#define WS_PORT                81
#define HEARTBEAT_MS         2000UL   // latido de aplicación hacia la app
#define WIFI_RETRY_MS       10000UL   // reintento de conexión STA
#define EVENT_RING_SIZE        16     // eventos guardados para resincronizar

// --- Hora (Colombia, UTC-5, sin horario de verano). Formato POSIX TZ.
#define TZ_POSIX        "<-05>5"
#define NTP_SERVER_1    "pool.ntp.org"
#define NTP_SERVER_2    "time.google.com"
