module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // Convierte las funciones marcadas con 'worklet' para que puedan correr en
    // el hilo de la cámara (frame processors de VisionCamera).
    plugins: [['react-native-worklets-core/plugin']],
  };
};
