import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    // Alles außer "/", "/favicon.svg" und "/_explorer/" gehört der virtuellen Vorschau.
    assetsDir: '_explorer/assets',
    // Zwei Seiten: der Explorer und die öffentliche Anmeldeseite (/_explorer/anmeldung).
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        anmeldung: fileURLToPath(new URL('./anmeldung.html', import.meta.url)),
      },
    },
  },
});
