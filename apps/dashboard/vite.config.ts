import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.API_URL ?? 'http://localhost:4000';
const live = process.env.LIVE_URL ?? 'http://localhost:4001';

// Proxy the API through the dev server so the browser sees one origin (no CORS).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/requests': api,
      '/metrics': api,
      '/live': { target: live.replace(/^http/, 'ws'), ws: true },
    },
  },
});
