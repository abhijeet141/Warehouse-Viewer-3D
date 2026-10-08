import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, type ProxyOptions } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// DB mode reads the real block stack from the local FloWMS services (launch.ps1).
// The browser reaches them through this dev proxy — same origin, so no CORS — one
// route per service. The JWT travels as a Bearer header and the fingerprint as an
// X-At-Fingerprint header; pyro wants the latter as the atFingerprint cookie, so the
// proxy rewrites it. No cookie is ever set on the viewer origin: localhost cookies
// ignore the port and would clobber the FloWMS web app's own atFingerprint.
const SERVICES: Record<string, number> = { locations: 8002, pods: 8003, products: 8005, jobs: 8018 };

// Optional server-side credentials, so nobody has to paste the token into every new
// tab: {"token": "…", "fingerprint": "…"} in the OS temp folder (or wherever
// FLOWMS_VIEWER_AUTH points). Read per request, never part of the project.
const AUTH_FILE = process.env.FLOWMS_VIEWER_AUTH ?? path.join(os.tmpdir(), 'flowms-viewer-auth.json');
function fileCredentials(): { token: string; fingerprint: string } | null {
  try {
    const j = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    return j && typeof j.token === 'string' && typeof j.fingerprint === 'string' ? j : null;
  } catch {
    return null;
  }
}

function serviceProxy(port: number): ProxyOptions {
  return {
    target: `http://localhost:${port}`,
    changeOrigin: true,
    // Read-only by contract: anything but GET never reaches a service.
    bypass(req) {
      if (req.method !== 'GET') return false;
    },
    configure(proxy) {
      proxy.on('proxyReq', (proxyReq, req) => {
        const fromFile = req.headers.authorization ? null : fileCredentials();
        if (fromFile) proxyReq.setHeader('authorization', `Bearer ${fromFile.token}`);
        const fpHeader = req.headers['x-at-fingerprint'];
        const fp = (Array.isArray(fpHeader) ? fpHeader[0] : fpHeader) || fromFile?.fingerprint;
        proxyReq.removeHeader('x-at-fingerprint');
        proxyReq.removeHeader('cookie');
        if (fp) proxyReq.setHeader('cookie', `atFingerprint=${fp}`);
      });
    },
  };
}

export default defineConfig({
  plugins: [svelte()],
  // Fixed port so this copy never collides with the other viewer instances
  // (5173 FloWMS web / standalone viewer, 5174–5176 Warehouse-3d-View).
  server: {
    port: 5178,
    strictPort: true,
    proxy: Object.fromEntries(Object.entries(SERVICES).map(([svc, port]) => [`/api/${svc}/`, serviceProxy(port)])),
  },
});
