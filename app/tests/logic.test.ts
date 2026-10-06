/**
 * Pruebas de la lógica pura de la app, ejecutadas en Node.js (sin teléfono):
 *   1. Franjas horarias (incluida la que cruza la medianoche).
 *   2. Cliente SMTP contra un servidor SMTP+TLS simulado (respuestas fragmentadas,
 *      multilínea, adjunto en base64 y dot-stuffing).
 *   3. Cliente WebSocket contra un ESP32 simulado: resincronización y
 *      reconexión automática tras un corte.
 *   4. Detección de movimiento por imagen con cuadros sintéticos: ruido,
 *      cambio de iluminación y una "persona" que cruza la escena.
 *
 * Ejecutar:  npx tsx tests/logic.test.ts
 */
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { WebSocketServer } from 'ws';
import { isScheduleActive, evaluateArmed, toMinutes } from '../src/utils/schedule';
import { sendMail, SocketLike } from '../src/services/SmtpClient';
import { Esp32Client, EspMessage } from '../src/services/Esp32Client';
import type { Schedule } from '../src/store';
import { analyzeLuma } from '../src/vision/motionAnalysis';
import { MotionDetector, DEFAULT_DETECTOR } from '../src/vision/MotionDetector';

let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✔ ${name}`); };

// ---------------------------------------------------------------- 1. Horarios
function testSchedules() {
  console.log('Horarios');
  const night: Schedule = { id: '1', label: 'Noche', days: [0], start: '22:00', end: '06:00', enabled: true }; // domingo
  const office: Schedule = { id: '2', label: 'Oficina', days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00', enabled: true };
  const at = (iso: string) => new Date(iso); // hora local del proceso

  assert.equal(toMinutes('07:30'), 450);
  assert.equal(toMinutes('24:00'), null);
  assert.equal(toMinutes('7:5'), null);
  ok('toMinutes valida HH:MM');

  // 2026-10-04 es domingo
  assert.equal(isScheduleActive(night, at('2026-10-04T23:30:00')), true);
  assert.equal(isScheduleActive(night, at('2026-10-05T02:00:00')), true);   // lunes madrugada: franja del domingo
  assert.equal(isScheduleActive(night, at('2026-10-05T06:00:00')), false);  // fin exclusivo
  assert.equal(isScheduleActive(night, at('2026-10-04T21:59:00')), false);
  assert.equal(isScheduleActive(night, at('2026-10-06T02:00:00')), false);  // martes madrugada: lunes no marcado
  ok('franja nocturna que cruza la medianoche');

  assert.equal(isScheduleActive(office, at('2026-10-05T08:00:00')), true);
  assert.equal(isScheduleActive(office, at('2026-10-05T17:00:00')), false);
  assert.equal(isScheduleActive(office, at('2026-10-04T10:00:00')), false); // domingo
  assert.equal(isScheduleActive({ ...office, enabled: false }, at('2026-10-05T09:00:00')), false);
  ok('franja diurna, días y desactivación');

  assert.equal(evaluateArmed(true, [], at('2026-10-05T09:00:00')).armed, true);
  assert.equal(evaluateArmed(false, [office], at('2026-10-05T09:00:00')).armed, true);
  assert.equal(evaluateArmed(false, [office], at('2026-10-05T18:00:00')).armed, false);
  ok('armado efectivo = manual OR franja activa');
}

// ---------------------------------------------------------------- 2. SMTP
// Certificado autofirmado SOLO para el servidor SMTP simulado de esta prueba
// (válido 100 años, CN=localhost). Va incluido para no depender de openssl,
// que no viene instalado en Windows.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDUzE/763A1b3ii
ebhtmZ601DpbdvvDMMYW8S+h8YeCL9qKVxo6WSqOtKUj3/BYAFLm5uf4JBON8B2S
2uN2IkBxp/WTkLTifsnSb5UaIK1p9fo8BiIblps7eqm68pbuMZxixWoFsT8ReIGl
oF8hxvirq7hLD9yUYB2RJPgrzEdZgOG7vF3SfAB5zfVq+UYNVHdZa+IgOm0/85Xu
MIYTtDFRo6+15gZiQ9rBJK0snBAASejpwwUilaIPIU8G+61RmoeNcj0fj45Ufqcr
eCZi+nd5snM4Cf+1DyyYbyiiBxlEKXgJEckizEpqgQEDI3eGkLemLnSt0WOn55eG
M029urOJAgMBAAECggEAC1uJx9R3uVRlJAfa2vesZ7KdmEDkHFWDtxkBnbM8VCud
bo2KU/OrILF90Gm9BFdlFVec6Sq0w/o9O9e0tPsMRTytj+YU73NMro9/zeSRWOLU
66P4qVALIjwwZ67XtSge9IsclufwSayMv+Qsu6ro3hHE3PXAZEdygIsQd1b4dmuA
b3+AdHWRSy18r6JNTJFkant2qgQaNbc25AbTrHepWFm4mhoMtYjKbGoc6DVPKjfb
4xcRBZOaajW6153eKjxvlblQTM99ejC+k6gZqrpiXj17VTAVPdaGA0pSxIb9hlpL
MT6RnDZkCLvmZPk/0RnHe/vYBo+zSUqvlmntxNPfcQKBgQD+I/uDEVUTgmAGxg7x
57Esz2zy2PakHppWna/JAyZx0pGx5KBp6fpxHV9e/qp1lEXR/AxbUqZfU0FBIWeA
pdYHyG2223Np0XHzvqsm5mb2L7y0dqc9rl8VrveRbrGiEQlL3sEKsFjh+eVL8ivM
iU1ICvLg3zg6HxhzGiFbxlbasQKBgQDWWuS/RojEh+h1LABtUI6uVHfZAOTdD0bj
SDd//ushZIRJO0zQ0fDzWqK6choVxvC29NDrlC+z5SbCL8Z9CpMHSFBfSORAkOcC
FxzpwzdrUthKgy7IJJ7PVtuIZBp7ZFt/JdKdxEPWI3SR9GxMThnU+EaG/z39vdXb
XWK9XyZsWQKBgQDtEgXaMz3osBMB3posYNSvF2PreidB2+ZfbEOBwPWI8kPE7aAS
jRh5kkvYIrpCaqljA7tHKWdXvyM9LXsO0CRDKF3oWPhluuKQ3MltxTpA5zEiKxlB
ebrrUEdTHC6KH1hLtSTg4rZXPrT+To87As3bqZL94FzkIwO8w6Bgqzl0UQKBgQCS
Yrhct/qm3Hmvq0EPZjhKbXz7QVUKcmhixurACoLg5xhAOrMW2IjIaFlBIrMVtCqn
h0E14JlDLXbunlnbAuGt04Cv0cOvJEXec5JXQe4S6Ry0pinInNmnlxWNa296XOrv
RhEzlNkO4F+3XUioQ534hyUDBER9iKsHiBrqYJSI4QKBgQDCabc+GYs5CE5Pzmup
juQ0FG+1rEPo5bPV5N0s9IPrBGbZGkSHpWPGrBeCcS7Sk17etIOCLrcoeTxDKibs
KNrLztYmk3CeJxfSt3KgD5RuVVUmetMelm9khPMxuOmhq/6aS8QZeJwl+kk5exwy
b1o96/aXOYFSZoO8IIvi6NvnWA==
-----END PRIVATE KEY-----`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDCzCCAfOgAwIBAgIUd+9hTZM/cd9hfMT1ryNiJundJF0wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAwNDE3MjYyM1oYDzIxMjYw
OTEwMTcyNjIzWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDUzE/763A1b3iiebhtmZ601DpbdvvDMMYW8S+h8YeC
L9qKVxo6WSqOtKUj3/BYAFLm5uf4JBON8B2S2uN2IkBxp/WTkLTifsnSb5UaIK1p
9fo8BiIblps7eqm68pbuMZxixWoFsT8ReIGloF8hxvirq7hLD9yUYB2RJPgrzEdZ
gOG7vF3SfAB5zfVq+UYNVHdZa+IgOm0/85XuMIYTtDFRo6+15gZiQ9rBJK0snBAA
SejpwwUilaIPIU8G+61RmoeNcj0fj45UfqcreCZi+nd5snM4Cf+1DyyYbyiiBxlE
KXgJEckizEpqgQEDI3eGkLemLnSt0WOn55eGM029urOJAgMBAAGjUzBRMB0GA1Ud
DgQWBBRjQi5Ao29rgE6LE3ojQtzL8xxFcDAfBgNVHSMEGDAWgBRjQi5Ao29rgE6L
E3ojQtzL8xxFcDAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQBu
5QsJ2knqRmEkM/KZiKsZtCu1bLY6ChXBBqSDpl5Y+VP/1rgH6TwhOt0s4iSmcB9K
tUdw929Uqbvm5fW6u8WU5L4fQikxKdX6OOpq4mN/CFpgy+IxqM2UzDXunrPINBTi
0QfFapS9Qenr5JJ2/0bUGIjE9FQzHnpjf5VzPZa8Gn8Gf+GAPiOzMh3n/8t5759m
CWWN1Ousmz3WxBs3u/qgQBdAS/+v7nOcHF0PoqsUeKbHqn1Fbx4leemUxZnRuBOH
lKQd/s2qZoFr/uzGq4KyYJLoVrW01ojWkMIlshtprSNXT6JYLy2mNGajngxHhFTQ
g12zMDEPtm5TJdDqOHDn
-----END CERTIFICATE-----`;

async function testSmtp() {
  console.log('SMTP sobre TLS');

  const received: { cmds: string[]; data: string } = { cmds: [], data: '' };
  const server = tls.createServer({ key: TEST_KEY, cert: TEST_CERT }, sock => {
    let buf = '';
    let inData = false;
    sock.write('220 mock.smtp ESMTP\r\n');
    sock.on('data', d => {
      buf += d.toString();
      if (inData) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end < 0) return;
        received.data = buf.slice(0, end);
        buf = buf.slice(end + 5);
        inData = false;
        sock.write('250 2.0.0 OK queued\r\n');
      }
      let i: number;
      while (!inData && (i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        received.cmds.push(line);
        if (line.startsWith('EHLO')) {
          // respuesta multilínea enviada en fragmentos para probar el búfer
          sock.write('250-mock.smtp hola\r\n250-AUTH LO');
          setTimeout(() => sock.write('GIN PLAIN\r\n250 8BITMIME\r\n'), 20);
        } else if (line === 'AUTH LOGIN') sock.write('334 VXNlcm5hbWU6\r\n');
        else if (line === Buffer.from('yo@gmail.com').toString('base64')) sock.write('334 UGFzc3dvcmQ6\r\n');
        else if (line === Buffer.from('clave').toString('base64')) sock.write('235 2.7.0 Accepted\r\n');
        else if (line === Buffer.from('mala').toString('base64')) sock.write('535 5.7.8 Bad credentials\r\n');
        else if (line.startsWith('MAIL FROM') || line.startsWith('RCPT TO')) sock.write('250 OK\r\n');
        else if (line === 'DATA') { inData = true; sock.write('354 Go ahead\r\n'); }
        else if (line === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
      }
    });
  });
  await new Promise<void>(r => server.listen(0, r));
  const port = (server.address() as any).port;

  const factory = (host: string, p: number) =>
    new Promise<SocketLike>((resolve, reject) => {
      const s = tls.connect({ host, port: p, rejectUnauthorized: false }, () => resolve(s as unknown as SocketLike));
      s.once('error', reject);
    });

  const photo = Buffer.alloc(5000, 7).toString('base64');
  const reply = await sendMail(
    { host: '127.0.0.1', port, user: 'yo@gmail.com', pass: 'clave', timeoutMs: 3000 },
    {
      from: 'yo@gmail.com', fromName: 'IDS Alertas', to: ['dueño@example.com'],
      subject: '🚨 Intrusión detectada',
      text: 'Línea 1\n.línea que empieza con punto',
      html: '<b>hola</b>',
      attachments: [{ filename: 'f.jpg', contentType: 'image/jpeg', base64: photo }],
    },
    factory,
  );
  assert.match(reply, /250 2\.0\.0 OK queued/);
  assert.deepEqual(received.cmds.slice(0, 2), ['EHLO ids-mobile', 'AUTH LOGIN']);
  assert.ok(received.cmds.includes('RCPT TO:<dueño@example.com>'));
  ok('diálogo SMTP completo con respuesta multilínea fragmentada');

  const msg = received.data;
  assert.ok(msg.split('\r\n').every(l => l.length <= 998), 'líneas dentro del límite RFC');
  assert.match(msg, /Subject: =\?UTF-8\?B\?/);
  const att = /filename="f\.jpg"\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/.exec(msg)![1];
  assert.equal(att.replace(/\r\n/g, ''), photo);
  assert.ok(att.split('\r\n').every(l => l.length <= 76));
  const textB64 = /charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/.exec(msg)![1];
  assert.equal(Buffer.from(textB64, 'base64').toString('utf8'), 'Línea 1\n.línea que empieza con punto');
  ok('MIME: asunto codificado, texto UTF-8 y adjunto base64 en líneas de 76');

  await assert.rejects(
    sendMail({ host: '127.0.0.1', port, user: 'yo@gmail.com', pass: 'mala', timeoutMs: 3000 },
      { from: 'yo@gmail.com', to: ['x@y.z'], subject: 's', text: 't' }, factory),
    (e: any) => e.code === 535,
  );
  ok('credenciales inválidas -> error 535 (no se reintenta)');

  server.close();
}

// ---------------------------------------------------------------- 3. WebSocket
async function testWebSocket() {
  console.log('WebSocket ESP32 simulado');
  const wss = new WebSocketServer({ port: 0 });
  const port = (wss.address() as any).port;
  const syncs: number[] = [];
  let connections = 0;

  wss.on('connection', sock => {
    connections++;
    sock.send(JSON.stringify({ type: 'hello', lastId: 3 }));
    sock.on('message', raw => {
      const m = JSON.parse(String(raw));
      if (m.cmd === 'sync') {
        syncs.push(m.lastId);
        for (let id = m.lastId + 1; id <= 3; id++) sock.send(JSON.stringify({ type: 'motion', id, replay: true }));
      }
      if (m.cmd === 'ping') sock.send(JSON.stringify({ type: 'pong', t: m.t }));
    });
  });

  const motions: number[] = [];
  const statuses: string[] = [];
  let lastId = 1;
  const client = new Esp32Client({
    onStatus: st => statuses.push(st),
    onRtt: () => {},
    onOpen: send => send({ cmd: 'sync', lastId }),
    onMessage: (m: EspMessage) => {
      if (m.type === 'motion') { motions.push(m.id); lastId = Math.max(lastId, m.id); }
    },
  });

  client.start(`ws://127.0.0.1:${port}/`);
  await waitFor(() => motions.length === 2, 3000);
  assert.deepEqual(motions, [2, 3]);
  ok('al conectar pide sync y recibe solo los eventos perdidos');

  // Corte abrupto: el "ESP32" tira todas las conexiones.
  wss.clients.forEach(c => c.terminate());
  await waitFor(() => connections === 2, 5000);
  await waitFor(() => syncs.length === 2, 2000);
  assert.deepEqual(syncs, [1, 3]);
  assert.ok(statuses.includes('reconnecting'));
  ok('reconexión automática con backoff y resincronización desde el último id');

  client.stop();
  wss.close();

  // Conexión "medio abierta": el socket sigue abierto pero el ESP32 dejó de hablar
  // (p. ej. se fue la energía del router). Solo el watchdog de latidos lo detecta.
  const silent = new WebSocketServer({ port: 0 });
  let silentConns = 0;
  silent.on('connection', () => { silentConns++; });
  const c2 = new Esp32Client({ onStatus: () => {}, onRtt: () => {}, onOpen: () => {}, onMessage: () => {} });
  const t0 = Date.now();
  c2.start(`ws://127.0.0.1:${(silent.address() as any).port}/`);
  await waitFor(() => silentConns === 2, 12000);
  const secs = (Date.now() - t0) / 1000;
  assert.ok(secs >= 7 && secs < 11, `reconectó a los ${secs}s`);
  ok(`watchdog detecta silencio y reconecta (${secs.toFixed(1)} s)`);
  c2.stop();
  silent.close();
}

// ---------------------------------------------------------------- 4. Imagen
function testVision() {
  console.log('Detección por imagen');
  const W = 320, H = 240, STRIDE = 384; // stride > ancho, como en el hardware real
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

  // Escena: degradado + ruido de sensor (±6). `light` suma brillo global;
  // `person` dibuja un rectángulo oscuro de 60×120 px en la posición x.
  const frame = (light = 0, person?: number) => {
    const buf = new Uint8Array(STRIDE * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let v = 80 + (x / W) * 100 + (rand() - 0.5) * 12 + light;
        if (person !== undefined && x >= person && x < person + 60 && y >= 100 && y < 220) v = 30;
        buf[y * STRIDE + x] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
    return buf;
  };

  let bg: number[] = [];
  const run = (buf: Uint8Array) => {
    const r = analyzeLuma(buf, W, H, STRIDE, bg, 25, 0.1);
    bg = r.background;
    return r;
  };

  run(frame());
  for (let i = 0; i < 10; i++) assert.ok(run(frame()).score < 0.005, 'el ruido no debe contar como movimiento');
  ok('escena quieta con ruido: puntuación ≈ 0');

  const lit = run(frame(40));
  assert.ok(lit.score < 0.01, `cambio de luz dio ${lit.score}`);
  for (let i = 0; i < 15; i++) run(frame(40));
  ok('encender una luz (+40 de brillo global) no dispara: compensación de brillo');

  const p = run(frame(40, 100));
  assert.ok(p.score > 0.05, `persona dio ${p.score}`);
  ok(`una persona en escena cambia el ${(p.score * 100).toFixed(1)} % de la imagen`);

  // Máquina de estados: calentamiento, confirmación y enfriamiento.
  const det = new MotionDetector({ ...DEFAULT_DETECTOR });
  det.reset(0);
  assert.equal(det.feed(0.5, 100, 1000).state, 'warmup');
  assert.equal(det.feed(0.5, 100, 3200).fired, false);          // 1er cuadro alto: candidato
  assert.equal(det.feed(0.0, 100, 3400).state, 'idle');         // un pico aislado se descarta
  assert.equal(det.feed(0.5, 100, 3600).state, 'candidate');
  const fired = det.feed(0.3, 100, 3800);
  assert.equal(fired.fired, true);
  assert.equal(fired.peakScore, 0.5);
  assert.equal(det.feed(0.5, 100, 9000).state, 'cooldown');
  assert.equal(det.feed(0.5, 5, 14000).state, 'dark');
  assert.equal(det.feed(0.5, 100, 14200).state, 'candidate');
  ok('máquina de estados: calentamiento, pico aislado ignorado, confirmación, enfriamiento y oscuridad');
}

function waitFor(cond: () => boolean, ms: number) {
  return new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (cond()) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('timeout esperando condición')); }
    }, 20);
  });
}

(async () => {
  testSchedules();
  testVision();
  await testSmtp();
  await testWebSocket();
  console.log(`\n${passed} pruebas OK`);
  process.exit(0);
})().catch(e => {
  console.error('FALLÓ:', e);
  process.exit(1);
});