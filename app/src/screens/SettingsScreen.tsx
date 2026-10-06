import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { addLog, getState, Settings, setState, useStore } from '../store';
import { mailConfig, mailConfigured, sendNow } from '../services/Mailer';
import { restartConnection } from '../services/Monitor';
import { isBatteryOptimized, openBatterySettings } from '../services/ForegroundService';
import { formatDateTime } from '../utils/schedule';
import { C, s } from '../theme';

export default function SettingsScreen({ visible }: { visible: boolean }) {
  const saved = useStore(st => st.settings);
  const [form, setForm] = useState<Settings>(saved);
  const [sending, setSending] = useState(false);
  const [batteryOpt, setBatteryOpt] = useState<boolean | null>(null);
  // Los números decimales se editan como texto ("1." es válido mientras se escribe).
  const [areaText, setAreaText] = useState(String(saved.areaThresholdPct));
  const [pixelText, setPixelText] = useState(String(saved.pixelThreshold));

  useEffect(() => {
    setForm(saved);
    setAreaText(String(saved.areaThresholdPct));
    setPixelText(String(saved.pixelThreshold));
  }, [saved]);
  useEffect(() => {
    if (visible) isBatteryOptimized().then(setBatteryOpt).catch(() => {});
  }, [visible]);

  if (!visible) return null;

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm(f => ({ ...f, [k]: v }));

  const save = (silent = false) => {
    const hostChanged = form.espHost !== saved.espHost || form.wsPort !== saved.wsPort;
    const clamp = (v: number, lo: number, hi: number, def: number) => (Number.isFinite(v) && v > 0 ? Math.min(hi, Math.max(lo, v)) : def);
    setState({
      settings: {
        ...form,
        espHost: form.espHost.trim(),
        areaThresholdPct: clamp(Number(areaText.replace(',', '.')), 0.2, 50, 2),
        pixelThreshold: Math.round(clamp(Number(pixelText), 5, 120, 25)),
      },
    });
    if (hostChanged) void restartConnection();
    if (!silent) Alert.alert('Guardado', 'La configuración se guardó.');
  };

  const testMail = async () => {
    save(true);
    if (!mailConfigured()) {
      Alert.alert('Faltan datos', 'Completa el correo remitente, la contraseña de aplicación y el destinatario.');
      return;
    }
    setSending(true);
    try {
      const { smtp, to } = mailConfig();
      const reply = await sendNow({
        from: smtp.user,
        fromName: 'IDS Alertas',
        to,
        subject: '✅ Prueba del sistema IDS',
        text: `Correo de prueba enviado el ${formatDateTime(Date.now())}. Si lo recibes, las alertas funcionarán.`,
      });
      addLog('alert', `Correo de prueba enviado: ${reply}`);
      Alert.alert('Enviado', 'Revisa la bandeja de entrada (y spam).');
    } catch (e) {
      addLog('error', `Prueba de correo fallida: ${(e as Error).message}`);
      Alert.alert('Error', (e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
      <Text style={s.h1}>Ajustes</Text>

      <View style={s.card}>
        <Text style={s.h2}>ESP32</Text>
        <Text style={s.label}>IP del ESP32 (la que muestra el Monitor Serie; 192.168.4.1 si estás en su AP)</Text>
        <TextInput style={s.input} value={form.espHost} onChangeText={v => set('espHost', v)} autoCapitalize="none" keyboardType="url" />
        <Text style={s.label}>Puerto WebSocket</Text>
        <TextInput style={s.input} value={String(form.wsPort)} onChangeText={v => set('wsPort', Number(v) || 81)} keyboardType="number-pad" />
      </View>

      <View style={s.card}>
        <Text style={s.h2}>Detección por imagen</Text>
        <Text style={s.muted}>
          Calibra mirando el medidor en Monitor: con la escena quieta el cambio debe quedar bastante por debajo del
          umbral, y al pasar una persona, por encima.
        </Text>
        <Text style={s.label}>Umbral de área: % de la imagen que debe cambiar (menor = más sensible)</Text>
        <TextInput
          style={s.input}
          value={areaText}
          onChangeText={setAreaText}
          keyboardType="decimal-pad"
        />
        <Text style={s.label}>Umbral de píxel: diferencia de brillo 0–255 (menor = más sensible, más ruido)</Text>
        <TextInput
          style={s.input}
          value={pixelText}
          onChangeText={setPixelText}
          keyboardType="number-pad"
        />
      </View>

      <View style={s.card}>
        <Text style={s.h2}>Correo de alerta (Gmail SMTP)</Text>
        <Text style={s.label}>Correo remitente (Gmail)</Text>
        <TextInput style={s.input} value={form.smtpUser} onChangeText={v => set('smtpUser', v)} autoCapitalize="none" keyboardType="email-address" />
        <Text style={s.label}>Contraseña de aplicación (16 caracteres, no tu contraseña normal)</Text>
        <TextInput style={s.input} value={form.smtpPass} onChangeText={v => set('smtpPass', v)} autoCapitalize="none" secureTextEntry />
        <Text style={s.label}>Destinatario(s), separados por coma</Text>
        <TextInput style={s.input} value={form.alertTo} onChangeText={v => set('alertTo', v)} autoCapitalize="none" keyboardType="email-address" />
        <Text style={s.label}>Intervalo mínimo entre correos (segundos)</Text>
        <TextInput
          style={s.input}
          value={String(form.minEmailIntervalSec)}
          onChangeText={v => set('minEmailIntervalSec', Math.max(0, Number(v) || 0))}
          keyboardType="number-pad"
        />
        <View style={s.between}>
          <Text style={s.text}>Adjuntar foto de la cámara</Text>
          <Switch value={form.attachPhoto} onValueChange={v => set('attachPhoto', v)} />
        </View>
        <Pressable style={s.btnGhost} onPress={testMail} disabled={sending}>
          {sending ? <ActivityIndicator color={C.text} /> : <Text style={s.text}>Enviar correo de prueba</Text>}
        </Pressable>
      </View>

      <View style={s.card}>
        <Text style={s.h2}>Segundo plano</Text>
        <Text style={s.muted}>
          Optimización de batería: {batteryOpt == null ? '—' : batteryOpt ? 'ACTIVADA (puede cortar la supervisión)' : 'desactivada ✔'}
        </Text>
        <Pressable style={s.btnGhost} onPress={() => openBatterySettings()}>
          <Text style={s.text}>Abrir ajustes de batería</Text>
        </Pressable>
      </View>

      <Pressable style={s.btn} onPress={() => save()}>
        <Text style={s.btnText}>Guardar</Text>
      </Pressable>
      <Text style={s.muted}>Último evento procesado: #{getState().lastEventId}</Text>
    </ScrollView>
  );
}
