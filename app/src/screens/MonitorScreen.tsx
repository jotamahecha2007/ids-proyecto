import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState as RNAppState, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Camera, useCameraDevice, useCameraFormat, useCameraPermission } from 'react-native-vision-camera';
import { useKeepAwake } from 'expo-keep-awake';
import { getState, setState, useStore } from '../store';
import { cameraBridge } from '../services/CameraBridge';
import { reportCameraMotion, sendTestEvent, startMonitoring, stopMonitoring, syncArmedToDevice } from '../services/Monitor';
import { useMotionFrameProcessor } from '../vision/useMotionFrameProcessor';
import type { DetectorOutput } from '../vision/MotionDetector';
import { evaluateArmed, formatDateTime } from '../utils/schedule';
import { C, s } from '../theme';

const CONN_COLOR = { connected: C.ok, connecting: C.warn, reconnecting: C.warn, disconnected: C.danger } as const;
const LOG_COLOR = { motion: C.warn, alert: C.ok, info: C.muted, error: C.danger } as const;
const DETECTOR_TEXT: Record<string, string> = {
  warmup: 'Estabilizando cámara…',
  idle: 'Vigilando',
  candidate: 'Posible movimiento…',
  cooldown: 'Movimiento detectado (pausa 10 s)',
  dark: 'Muy oscuro para detectar',
};

export default function MonitorScreen({ visible }: { visible: boolean }) {
  useKeepAwake(); // la pantalla no se apaga: Android no entrega la cámara con la pantalla apagada

  const { hasPermission, requestPermission } = useCameraPermission();
  const [facing, setFacing] = useState<'back' | 'front'>('back');
  const device = useCameraDevice(facing);
  // 1280×720 a 30 fps: suficiente para detectar y para la foto de evidencia.
  const format = useCameraFormat(device, [{ videoResolution: { width: 1280, height: 720 } }, { fps: 30 }]);
  const camRef = useRef<Camera>(null);
  const [appActive, setAppActive] = useState(RNAppState.currentState === 'active');

  const conn = useStore(st => st.conn);
  const rtt = useStore(st => st.rttMs);
  const esp = useStore(st => st.esp);
  const monitoring = useStore(st => st.monitoring);
  const manualAway = useStore(st => st.manualAway);
  const schedules = useStore(st => st.schedules);
  const log = useStore(st => st.log);
  const nextRetry = useStore(st => st.nextRetryMs);
  const motion = useStore(st => st.motion);
  const areaPct = useStore(st => st.settings.areaThresholdPct);
  const pixelThreshold = useStore(st => st.settings.pixelThreshold);

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const sub = RNAppState.addEventListener('change', st => setAppActive(st === 'active'));
    return () => sub.remove();
  }, []);

  const cameraActive = appActive && hasPermission && !!device;
  useEffect(() => {
    cameraBridge.attach(camRef.current);
    cameraBridge.setActive(cameraActive);
  }, [cameraActive, device]);

  // --- Detección de movimiento por imagen
  const onFrame = useCallback((score: number, brightness: number, out: DetectorOutput) => {
    setState({ motion: { score, brightness, state: out.state } });
  }, []);
  const onMotion = useCallback((peak: number) => {
    // Solo se alerta con la supervisión iniciada; si no, la detección sirve para calibrar.
    if (getState().monitoring) reportCameraMotion(peak);
  }, []);
  const frameProcessor = useMotionFrameProcessor({
    enabled: cameraActive,
    areaThreshold: areaPct / 100,
    pixelThreshold,
    resetKey: device?.id,
    onFrame,
    onMotion,
  });

  const armed = evaluateArmed(manualAway, schedules, new Date(now));
  const scorePct = motion.score * 100;
  const meter = Math.min(1, motion.score / Math.max(0.001, (areaPct / 100) * 2)); // el umbral queda a la mitad de la barra

  const toggleAway = () => {
    setState({ manualAway: !manualAway });
    syncArmedToDevice();
  };

  return (
    <View style={[s.screen, !visible && styles.hidden]}>
      {/* --- Vista de cámara: la imagen se analiza en el mismo teléfono --- */}
      <View style={styles.camBox}>
        {!hasPermission ? (
          <Pressable style={[s.btn, styles.center]} onPress={requestPermission}>
            <Text style={s.btnText}>Permitir cámara</Text>
          </Pressable>
        ) : !device ? (
          <Text style={[s.text, styles.center]}>No se encontró cámara</Text>
        ) : (
          <Camera
            ref={camRef}
            style={StyleSheet.absoluteFill}
            device={device}
            format={format}
            isActive={cameraActive}
            photo
            video={false}
            audio={false}
            pixelFormat="yuv"
            frameProcessor={frameProcessor}
            onInitialized={() => cameraBridge.attach(camRef.current)}
            onError={e => console.warn('Cámara', e.code, e.message)}
          />
        )}
        <View style={styles.overlayTop}>
          <View style={[styles.dot, { backgroundColor: armed.armed ? C.danger : C.muted }]} />
          <Text style={styles.overlayText}>{armed.armed ? 'ARMADO' : 'DESARMADO'}</Text>
          <Text style={[styles.overlayText, { marginLeft: 'auto' }]}>{formatDateTime(now).slice(0, 19)}</Text>
        </View>
        <Pressable style={styles.flip} onPress={() => setFacing(f => (f === 'back' ? 'front' : 'back'))}>
          <Text style={styles.overlayText}>⟲</Text>
        </Pressable>
      </View>

      {/* --- Medidor de movimiento (sirve para calibrar la sensibilidad) --- */}
      <View style={styles.meterBox}>
        <View style={s.between}>
          <Text style={s.muted}>{DETECTOR_TEXT[motion.state] ?? motion.state}</Text>
          <Text style={s.muted}>
            cambio {scorePct.toFixed(1)} % / umbral {areaPct} % · brillo {Math.round(motion.brightness)}
          </Text>
        </View>
        <View style={styles.meterTrack}>
          <View style={[styles.meterFill, { width: `${meter * 100}%`, backgroundColor: motion.score >= areaPct / 100 ? C.danger : C.ok }]} />
          <View style={styles.meterMark} />
        </View>
      </View>

      <View style={s.pad}>
        {/* --- Estado de conexión con el ESP32 --- */}
        <View style={s.card}>
          <View style={s.between}>
            <View style={s.row}>
              <View style={[styles.dot, { backgroundColor: CONN_COLOR[conn] }]} />
              <Text style={s.h2}>ESP32: {conn}</Text>
            </View>
            <Text style={s.muted}>{rtt != null ? `RTT ${rtt} ms` : nextRetry ? `reintento en ${(nextRetry / 1000).toFixed(1)} s` : ''}</Text>
          </View>
          {esp && (
            <Text style={s.muted}>
              RSSI {esp.rssi ?? '-'} dBm · eventos registrados {esp.lastId ?? 0}
              {esp.timeSynced ? '' : ' · sin NTP'}
            </Text>
          )}
          <Text style={s.muted}>{armed.reason}</Text>
        </View>

        <View style={s.row}>
          <Pressable style={[s.btn, { flex: 1, backgroundColor: manualAway ? C.danger : C.accent }]} onPress={toggleAway}>
            <Text style={s.btnText}>{manualAway ? 'Fuera de casa: ON' : 'Activar "Fuera de casa"'}</Text>
          </Pressable>
          <Pressable
            style={[s.btn, { flex: 1, backgroundColor: monitoring ? '#374151' : C.ok }]}
            onPress={() => (monitoring ? stopMonitoring() : startMonitoring())}>
            <Text style={s.btnText}>{monitoring ? 'Detener supervisión' : 'Iniciar supervisión'}</Text>
          </Pressable>
        </View>
        <Pressable style={s.btnGhost} onPress={sendTestEvent} disabled={conn !== 'connected'}>
          <Text style={[s.text, conn !== 'connected' && { color: C.muted }]}>Simular intrusión (evento de prueba desde el ESP32)</Text>
        </Pressable>
      </View>

      {/* --- Bitácora --- */}
      <FlatList
        style={styles.log}
        data={log}
        keyExtractor={i => i.id}
        ListEmptyComponent={<Text style={[s.muted, { padding: 16 }]}>Sin eventos todavía.</Text>}
        renderItem={({ item }) => (
          <View style={styles.logRow}>
            <Text style={[s.muted, { width: 64 }]}>{formatDateTime(item.at).slice(11, 19)}</Text>
            <Text style={[s.text, { flex: 1, color: LOG_COLOR[item.kind] }]}>{item.text}</Text>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: { display: 'none' },
  camBox: { height: 260, backgroundColor: '#000', justifyContent: 'center' },
  center: { alignSelf: 'center' },
  overlayTop: { position: 'absolute', top: 8, left: 10, right: 10, flexDirection: 'row', alignItems: 'center', gap: 6 },
  overlayText: { color: '#fff', fontWeight: '700', textShadowColor: '#000', textShadowRadius: 4 },
  flip: { position: 'absolute', bottom: 10, right: 12, backgroundColor: '#0008', borderRadius: 18, paddingHorizontal: 10, paddingVertical: 4 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  meterBox: { paddingHorizontal: 16, paddingTop: 10, gap: 6 },
  meterTrack: { height: 8, borderRadius: 4, backgroundColor: C.border, overflow: 'hidden' },
  meterFill: { height: 8 },
  meterMark: { position: 'absolute', left: '50%', top: 0, bottom: 0, width: 2, backgroundColor: C.text },
  log: { flex: 1, paddingHorizontal: 16 },
  logRow: { flexDirection: 'row', gap: 8, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: C.border },
});
