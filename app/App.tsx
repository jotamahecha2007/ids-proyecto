import React, { useEffect, useState } from 'react';
import { AppState as RNAppState, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { hydrate, useStore } from './src/store';
import MonitorScreen from './src/screens/MonitorScreen';
import ScheduleScreen from './src/screens/ScheduleScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import { setStopHandler, setupNotifications } from './src/services/ForegroundService';
import { reconnectNow, stopMonitoring } from './src/services/Monitor';
import { C } from './src/theme';

type Tab = 'monitor' | 'schedule' | 'settings';
const TABS: { id: Tab; label: string }[] = [
  { id: 'monitor', label: 'Monitor' },
  { id: 'schedule', label: 'Horarios' },
  { id: 'settings', label: 'Ajustes' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('monitor');
  const hydrated = useStore(st => st.hydrated);

  useEffect(() => {
    void hydrate();
    void setupNotifications();
    const unsubscribe = setStopHandler(() => void stopMonitoring());
    // Al volver a primer plano, reconectar de inmediato en vez de esperar el backoff.
    const sub = RNAppState.addEventListener('change', st => st === 'active' && reconnectNow());
    return () => {
      unsubscribe();
      sub.remove();
    };
  }, []);

  if (!hydrated) return <View style={styles.root} />;

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <View style={{ flex: 1 }}>
          {/* El monitor se mantiene montado siempre: la cámara debe seguir disponible para capturar evidencia. */}
          <MonitorScreen visible={tab === 'monitor'} />
          <ScheduleScreen visible={tab === 'schedule'} />
          <SettingsScreen visible={tab === 'settings'} />
        </View>
        <View style={styles.tabs}>
          {TABS.map(t => (
            <Pressable key={t.id} style={styles.tab} onPress={() => setTab(t.id)}>
              <Text style={[styles.tabText, tab === t.id && styles.tabActive]}>{t.label}</Text>
            </Pressable>
          ))}
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  tabs: { flexDirection: 'row', borderTopWidth: 1, borderColor: C.border, backgroundColor: C.card },
  tab: { flex: 1, paddingVertical: 14, alignItems: 'center' },
  tabText: { color: C.muted, fontWeight: '600' },
  tabActive: { color: C.accent },
});
