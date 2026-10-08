import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  // Fixed port so this copy never collides with the other viewer instances
  // (5173 FloWMS web / standalone viewer, 5174–5176 Warehouse-3d-View, 5178 the DB-mode copy).
  server: { port: 5179, strictPort: true },
});
