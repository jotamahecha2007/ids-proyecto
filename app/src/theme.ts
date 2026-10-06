import { StyleSheet } from 'react-native';

export const C = {
  bg: '#0f1115',
  card: '#181b22',
  border: '#272b35',
  text: '#e8eaf0',
  muted: '#8a90a0',
  accent: '#4f8cff',
  danger: '#ef4444',
  ok: '#22c55e',
  warn: '#f59e0b',
};

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  pad: { padding: 16, gap: 12 },
  card: { backgroundColor: C.card, borderRadius: 12, borderWidth: 1, borderColor: C.border, padding: 14, gap: 8 },
  h1: { color: C.text, fontSize: 20, fontWeight: '700' },
  h2: { color: C.text, fontSize: 16, fontWeight: '600' },
  text: { color: C.text, fontSize: 14 },
  muted: { color: C.muted, fontSize: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  input: {
    backgroundColor: '#0b0d11', color: C.text, borderWidth: 1, borderColor: C.border,
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14,
  },
  label: { color: C.muted, fontSize: 12, marginBottom: 4 },
  btn: { backgroundColor: C.accent, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 14, alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  btnGhost: { borderWidth: 1, borderColor: C.border, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, alignItems: 'center' },
});
