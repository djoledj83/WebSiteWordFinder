import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// In development the UI runs on Vite's server and every /api request is
// forwarded to the backend, so the browser sees a single origin (no CORS).
// In production the backend serves the built files itself (see backend/src/server.js).
//
// Both the dev port and the backend address come from frontend/.env
// (copy frontend/.env.example); plain environment variables work too.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    server: {
      port: Number(env.PORT) || 5173,
      proxy: {
        '/api': { target: env.BACKEND_URL || 'http://localhost:4000', changeOrigin: false },
      },
    },
  };
});
