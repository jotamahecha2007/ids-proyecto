import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { Schedule, setState, useStore } from '../store';
import { syncArmedToDevice } from '../services/Monitor';
import { DAY_LABELS, isScheduleActive, toMinutes } from '../utils/schedule';
import { C, s } from '../theme';

const WEEKDAYS = [1, 2, 3, 4, 5];

export default function ScheduleScreen({ visible }: { visible: boolean }) {
  const schedules = useStore(st => st.schedules);
  const [label, setLabel] = useState('Noche');
  const [start, setStart] = useState('22:00');
  const [end, setEnd] = useState('06:00');
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);

  if (!visible) return null;

  const update = (next: Schedule[]) => {
    setState({ schedules: next });
    syncArmedToDevice();
  };

  const add = () => {
    if (toMinutes(start) === null || toMinutes(end) === null) {
      Alert.alert('Hora inválida', 'Usa el formato HH:MM (24 h), por ejemplo 07:30.');
      return;
    }
    if (days.length === 0) {
      Alert.alert('Sin días', 'Selecciona al menos un día.');
      return;
    }
    update([
      ...schedules,
      { id: String(Date.now()), label: label.trim() || 'Franja', start, end, days: [...days].sort(), enabled: true },
    ]);
  };

  const toggleDay = (d: number) => setDays(ds => (ds.includes(d) ? ds.filter(x => x !== d) : [...ds, d]));

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={s.h1}>Franjas de vigilancia</Text>
      <Text style={s.muted}>
        El sistema se arma automáticamente dentro de cualquier franja activa, o en todo momento si activas
        "Fuera de casa". Si la hora final es menor que la inicial, la franja cruza la medianoche.
      </Text>

      {schedules.map(sc => {
        const active = isScheduleActive(sc, new Date());
        return (
          <View key={sc.id} style={[s.card, active && { borderColor: C.danger }]}>
            <View style={s.between}>
              <View>
                <Text style={s.h2}>{sc.label} {active ? '· ACTIVA' : ''}</Text>
                <Text style={s.text}>{sc.start} – {sc.end}</Text>
                <Text style={s.muted}>{sc.days.map(d => DAY_LABELS[d]).join(' ')}</Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 6 }}>
                <Switch
                  value={sc.enabled}
                  onValueChange={v => update(schedules.map(x => (x.id === sc.id ? { ...x, enabled: v } : x)))}
                />
                <Pressable onPress={() => update(schedules.filter(x => x.id !== sc.id))}>
                  <Text style={{ color: C.danger }}>Eliminar</Text>
                </Pressable>
              </View>
            </View>
          </View>
        );
      })}

      <View style={s.card}>
        <Text style={s.h2}>Nueva franja</Text>
        <Text style={s.label}>Nombre</Text>
        <TextInput style={s.input} value={label} onChangeText={setLabel} placeholderTextColor={C.muted} />
        <View style={s.row}>
          <View style={{ flex: 1 }}>
            <Text style={s.label}>Desde (HH:MM)</Text>
            <TextInput style={s.input} value={start} onChangeText={setStart} keyboardType="numbers-and-punctuation" maxLength={5} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.label}>Hasta (HH:MM)</Text>
            <TextInput style={s.input} value={end} onChangeText={setEnd} keyboardType="numbers-and-punctuation" maxLength={5} />
          </View>
        </View>
        <Text style={s.label}>Días</Text>
        <View style={[s.row, { flexWrap: 'wrap' }]}>
          {DAY_LABELS.map((d, i) => (
            <Pressable
              key={d}
              onPress={() => toggleDay(i)}
              style={[s.btnGhost, { paddingVertical: 6 }, days.includes(i) && { backgroundColor: C.accent, borderColor: C.accent }]}>
              <Text style={s.text}>{d}</Text>
            </Pressable>
          ))}
        </View>
        <View style={s.row}>
          <Pressable style={s.btnGhost} onPress={() => setDays(WEEKDAYS)}><Text style={s.text}>L–V</Text></Pressable>
          <Pressable style={s.btnGhost} onPress={() => setDays([0, 1, 2, 3, 4, 5, 6])}><Text style={s.text}>Todos</Text></Pressable>
        </View>
        <Pressable style={s.btn} onPress={add}>
          <Text style={s.btnText}>Agregar franja</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}
