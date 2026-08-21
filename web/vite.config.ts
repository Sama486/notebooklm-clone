import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Die .env liegt im Repo-Wurzelverzeichnis, damit Server und Frontend sich
  // eine einzige Datei teilen.
  envDir: path.resolve(here, '..'),
  server: {
    port: 5310,
    // Im Entwicklungsbetrieb laeuft alles ueber denselben Ursprung. Damit ist
    // CORS lokal kein Thema und der Streaming-Pfad verhaelt sich wie spaeter
    // in der Produktion.
    proxy: {
      '/api': {
        target: 'http://localhost:4310',
        changeOrigin: true,
      },
    },
  },
  build: {
    // Keine Quellkarten im Produktionsbuild: sie wuerden den gesamten
    // Quelltext oeffentlich mit ausliefern.
    sourcemap: false,
  },
});
