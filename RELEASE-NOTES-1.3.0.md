# Soprema Substitution Tool — v1.3.0

**Release date:** 2026-04-30
**Theme:** Telemetry — knowing what's actually working

## What's new

The app now phones home with a small set of usage events so the team can
see what's working in real use, prioritize improvements, and respond to
issues faster — without anyone needing to email a screenshot of a bug.

This is internal-plumbing only. No new buttons, no UI changes, no workflow
changes. Davis will not notice anything different in day-to-day use.

## What gets tracked

Four events fire from the app to a private endpoint at
`007-technologies-website.pages.dev`:

1. **`app_launched`** — every time the app opens
2. **`spec_uploaded`** — every time a spec PDF is selected for analysis
3. **`subrequest_generated`** — every time the AI completes a substitution
   request (with a count of matched products)
4. **`bundle_exported`** — every time the "Download full package" button is
   used (with page count, datasheet count, any fetch/merge failures)

Each event includes the app version, OS platform, and a stable customer
identifier — nothing identifying the user personally.

## What is *not* tracked

- No content from spec PDFs
- No content from generated requests or cover letters
- No project names, addresses, customer info
- No keystrokes, screen contents, screenshots
- No raw IP addresses (hashed at the server with a salt)

If the telemetry endpoint is ever unreachable, the app continues working
normally — telemetry calls are fire-and-forget and never block the UI.

## Bug fix

- `subrequest_generated` event was reporting `productCount: 0` regardless
  of how many products were actually matched. The hook was reading
  `matchedData.products` instead of `matchedData.matches`. Fixed; counts
  now report correctly.

## Internal

- New `src/services/telemetry.js` — fire-and-forget POST client with 5s
  timeout, never throws, silently no-ops if telemetry config is absent
- Three new `config.json` fields: `CUSTOMER_ID`, `TELEMETRY_ENDPOINT`,
  `TELEMETRY_KEY` (with corresponding entries in `config.example.json`)
- Four `track()` call sites in `src/main/main.js` at the IPC handler
  boundaries
- Backed by Cloudflare Pages Functions + D1 (serverless SQLite) at the
  edge — see the website repo for the server side

## Upgrade path

Davis will receive this update silently via electron-updater on next
launch. No reinstall needed. The first event the team will see is an
`app_launched` from `soprema-davis` with version `1.3.0`.

## Known limitations

- Telemetry endpoint URL is hardcoded in config.json. For multi-tenant
  builds (separate manufacturer customers) we'll move to per-customer
  endpoints or per-customer auth keys — future work.
- No client-side opt-out toggle yet. Reasonable to add as a setting
  before broader distribution.

## Next up

- Admin dashboard at `/admin` on the website for browsing telemetry data
  (filter by customer, event type, date range)
- `/download` page on the public site with lead capture before installer
  delivery
- Per-customer Anthropic key support (decouple from build-time bundling)
