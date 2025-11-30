// vite.config.ts

import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    dts({
      insertTypesEntry: true, // Asegura que los tipos se generen en el entry point
    }),
  ],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'), // Tu punto de entrada
      name: 'PinoConfig',
      fileName: (format) => `index.${format}.js`, // Generará index.es.js, index.cjs.js
      formats: ['es', 'cjs'],
    },
    // Excluir dependencias externas para que no se incluyan en el bundle final
    rollupOptions: {
      external: ['pino', 'node-cron'],
    },
  },
});
