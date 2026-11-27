import { setTimeout as pause } from 'node:timers/promises';
import '../app-config.js';

const schemaRelease = '20261127223040';
const applicationOrigin = 'https://applications.nature-care.net';
const ownerOrigin = 'https://owner.nature-care.net';
const { supabaseUrl, supabaseAnonKey, functionsPath } = globalThis.DELIVERY_CONFIG;

async function acceptsOrigin(name, origin) {
  const response = await fetch(supabaseUrl + functionsPath + '/' + name, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, apikey, content-type' },
    redirect: 'error',
    signal: AbortSignal.timeout(7000),
  });
  return response.ok && response.headers.get('access-control-allow-origin') === origin;
}

async function isReady() {
  const response = await fetch(supabaseUrl + '/rest/v1/rpc/delivery_schema_release', {
    headers: { apikey: supabaseAnonKey, 'Cache-Control': 'no-cache' },
    redirect: 'error',
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok || await response.json() !== schemaRelease) return false;
  const edges = await Promise.all([
    acceptsOrigin('admin-set-password', applicationOrigin),
    acceptsOrigin('native-device', applicationOrigin),
    acceptsOrigin('webpage-text', applicationOrigin),
    acceptsOrigin('owner-invite-admin', ownerOrigin),
    acceptsOrigin('owner-manage-admin', ownerOrigin),
  ]);
  return edges.every(Boolean);
}

if (process.env.CONTEXT === 'production') {
  const deadline = Date.now() + 8 * 60 * 1000;
  let ready = false;
  do {
    try { ready = await isReady(); } catch { ready = false; }
    if (ready) break;
    await pause(10000);
  } while (Date.now() < deadline);
  if (!ready) throw new Error('Production database or Edge Functions have not reached the required release. Netlify will keep serving its previous successful deploy.');
  console.log('Production schema and Edge Function origins are ready.');
}
