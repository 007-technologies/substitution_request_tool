/**
 * Skyfall telemetry client.
 *
 * Fires fire-and-forget POST events to the 007 Technologies telemetry endpoint
 * (Cloudflare Pages Function backed by D1).
 *
 * Reads config from global.appConfig — populated by main.js at startup.
 * Required config fields:
 *   - CUSTOMER_ID         (e.g., "soprema-davis")
 *   - TELEMETRY_ENDPOINT  (e.g., "https://007technologies.com/api/telemetry")
 *   - TELEMETRY_KEY       (shared secret matching Cloudflare's env var)
 *
 * If any required field is missing, telemetry silently no-ops. This means
 * old builds without telemetry config keep working unchanged.
 *
 * Hard rules:
 *   1. Never throw. Telemetry failures must NEVER break the app.
 *   2. Never block. All calls are fire-and-forget with a 5s timeout.
 *   3. Never log PII. The server hashes IPs; the client sends no user content.
 */

const { app } = require('electron');
const os = require('os');

const TIMEOUT_MS = 5000;

// System info that's stable for the life of the process. Computed once at
// require time so we don't hit the OS module on every track() call.
const SYSTEM_INFO = Object.freeze({
  arch: process.arch,                                                 // 'x64' | 'arm64' | 'arm' | 'ia32'
  total_memory_mb: Math.round(os.totalmem() / 1024 / 1024),           // total system RAM in MB
  cpu_count: os.cpus().length,                                        // # logical cores
  os_release: os.release(),                                           // kernel version, e.g. '23.4.0'
  electron: process.versions.electron,
  node: process.versions.node,
});

async function track(event, metadata = {}) {
  try {
    const cfg = global.appConfig || {};
    const endpoint = cfg.TELEMETRY_ENDPOINT;
    const key = cfg.TELEMETRY_KEY;
    const customerId = cfg.CUSTOMER_ID;

    // Missing config = silent no-op. Lets old builds keep working,
    // and lets dev builds skip telemetry by leaving config blank.
    if (!endpoint || !key || !customerId) return;

    // Merge system info + per-event metadata. System info comes first so
    // event-specific metadata can override (it shouldn't, but defensive).
    const mergedMetadata = {
      ...SYSTEM_INFO,
      // Free memory at moment of event — dynamic, not stable like the rest
      free_memory_mb: Math.round(os.freemem() / 1024 / 1024),
      ...(metadata && typeof metadata === 'object' ? metadata : {}),
    };

    const payload = {
      event,
      customer_id: customerId,
      product: 'skyfall',
      version: app.getVersion(),
      platform: process.platform,
      metadata: mergedMetadata,
      client_ts: new Date().toISOString(),
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telemetry-Key': key,
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // Swallow everything. Never throw, never log to user-facing surfaces.
    // The dev console will show this in unpackaged builds, which is useful.
    if (!app.isPackaged) {
      console.warn('[telemetry] suppressed:', err && err.message);
    }
  }
}

module.exports = { track };
