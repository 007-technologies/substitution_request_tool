# Cipher v1.4.0 — release notes

**Pre-staged:** 2026-04-30
**Audience:** Davis Haddock, Soprema (pilot)
**Auto-update:** Yes — Davis's v1.0.0 install will pick this up on next
launch (after he installs v1.3 manually OR auto-updates through it).

**Ship gate:** Anthropic + R2 credentials must rotate first. After
rotation, bump `package.json` to 1.4.0 and `npm run publish`. Old keys
remain active for 24h overlap so Davis sees no downtime.

## What's new

### License validation

Cipher now checks each launch against a server-side allowlist
(`/api/license/check` keyed off the bundled `CUSTOMER_ID`). After 3
consecutive invalid responses across launches, a soft amber banner
appears: "This build's license check isn't matching our records. Please
reach out so we can sort it." Never blocks app functionality. Real
customers should never see this. Implementation note: network failures
do NOT count as invalid — only definitive `valid: false` from the
server. Counter resets on the next valid response.

### In-app feedback

New "Send feedback" item in the sidebar (under Library / Help). Modal
with category buttons (Bug / Idea / Praise / Other), free-form textarea,
and optional reply email. Submissions land in Reed's inbox via Resend
plus the new `/admin/` feedback tab. Body never logged in telemetry —
only category, length, and whether an email was provided.

### Confidence flags on product matches

Match cards now surface the AI's confidence score with a colored dot +
hover tooltip explaining what each level means in practice. Summary
banner above the match cards shows total + per-bucket counts ("12
matches · 7 high · 4 medium · 1 low"), with a "Show flagged only" toggle
that hides high-confidence rows so Davis can focus on what needs scrutiny.

### "What's new" modal

After auto-update completes, on next launch Davis sees a one-time
changelog modal listing the highlights for that version. Suppressed on
first-ever install (no prior version to be upgrading from). Skipped
silently if no changelog entry exists for the new version.

### First-launch onboarding

Brand-new installs see a one-time four-step walkthrough (Upload →
Analyze → Review → Export) before they reach the upload screen. Won't
double-stack with the "What's new" modal (returning user beats first-time
tutorial). Suppressed forever after first dismissal via
`localStorage.cipherOnboarded`.

### Sample-spec affordance

If `assets/samples/sample-spec.pdf` is bundled with the build, the
upload screen surfaces a "Try with a sample spec" link beneath the
dropzone, plus a parallel link inside the onboarding modal. Auto-runs
the analyze flow on click so cold-arrival prospects see a result without
needing their own spec PDF.

### Recent-projects search

The Recent Sessions library view gets a search box that filters by
project name, filename, and formatted date. Tokenized AND search so
"walgreens april" finds the Walgreens job from April. Auto-focuses on
open. **Cmd/Ctrl+F** when on the recent screen jumps cursor to the
search input.

### Brand-customizable cover letter (multi-tenant prep)

Cover letter signature line and print-mode page header now drive off
config.json's `BRAND_*` fields. Default = Soprema for legacy builds.
When onboarding Carlisle/GAF/JM/IKO this fall, the brand swap is a
config-only change. Note: full body-copy brand swap is not yet
complete; v1.5 will sweep the remaining hardcoded "Soprema" mentions.

### Settings polish

- Customer ID surfaced as a new card so Davis can see which build he's on.
- "Check for updates" button fires `autoUpdater` immediately rather than
  waiting for the hourly background poll. Inline status feedback.
- "Send feedback" CTA opens the same modal as the sidebar nav item.

### Richer progress messaging during analyze

The analyze progress ticker now shows concrete numbers as the pipeline
runs: "Reading specification… 4.3 MB" → "Found 12 roofing-related pages"
→ "Catalog loaded — 156 Soprema documents available" → "Found 8 product
references in the spec" → "Matching against 47 candidate Soprema
products…" → "Matched 6 Soprema products to the spec." Makes the 30-90
second wait feel productive instead of mechanical.

### Friendlier error messages

The `friendlyError()` helper grew from 7 cases to 16. Coverage: Anthropic
rate limits, invalid keys, low credit balance, 5xx server errors; PDF
read errors (invalid format, scanned, encrypted, oversized); R2 catalog
failures; network/timeout errors; write-permission errors; full disk;
locked files; PDF assembly failures. Routed through `download-datasheet`,
`export-pdf`, `export-sub-request-pdf`, `export-bundle-pdf`. Each path
also fires `trackError` for visibility in admin.

### Telemetry expansions

- New `feedback_sent` event with category metadata (body never logged).
- New `sample_spec_loaded` event with `source` metadata (upload-screen
  or onboarding-modal — funnel insight).
- New `error` events from the previously-unmonitored bundle/export paths.

## Internal

- `trackEvent` IPC bridge for renderer-initiated telemetry with
  allow-listed event names + metadata sanitization.
- `getClient()` in `claude.js` now resolves API keys in priority order:
  user-supplied → bundled → throws clear "no key configured" error.
- New `resetClient()` so the cached Anthropic client picks up key changes
  without an app restart.
- Brand identity exposed via `getAppInfo` and cached on the renderer side
  as `cipherBrand`. Default fallback to Soprema for builds pre-dating
  the BRAND_* config keys.

## Upgrade path

- Davis's v1.0.0 install: he hasn't relaunched since the v1.3 release on
  2026-04-29, so v1.3's auto-updater hasn't fired yet. When he does
  relaunch, v1.3 → v1.4 chain happens in two background updates (or one
  if v1.4 ships before he relaunches at all).
- Telemetry should land in admin with the new event types within minutes
  of his first launch on the new version.

## Known limitations

- Sample-spec slot exists but no curated PDF is bundled yet. The "Try
  with a sample spec" link stays hidden until one is dropped at
  `assets/samples/sample-spec.pdf`.
- Brand swap on cover letter is partial (signature + page header only).
  Body copy still says "Soprema" in several places. v1.5 will complete
  the sweep.
- License-allowlist env var on Cloudflare Pages must be set before the
  endpoint becomes meaningful — without it the server returns
  `valid: true` for everyone (permissive default).

## Files changed

- `package.json` — version bump (pending)
- `config.example.json` — `BRAND_*` fields and BYO comment
- `src/main/main.js` — license validation, feedback IPC, sample-spec IPC,
  trackEvent IPC, BYO API key handlers, check-for-updates handler,
  friendlyError expansion, brand info via getAppInfo, telemetry hooks
  on bundle/export error paths
- `src/main/preload.js` — sendFeedback, getSampleSpec, trackEvent,
  checkForUpdates, getApiKeyStatus, saveUserApiKey, clearUserApiKey,
  onLicenseStatus
- `src/renderer/index.html` — feedback modal, what's-new modal,
  onboarding modal, sample-spec hint, license banner, settings cards
  (Customer / Send feedback / API key / Check updates), Feedback sidebar
  nav item
- `src/renderer/app.js` — feedback flow, what's-new + onboarding modal
  logic, sample-spec affordance, recent-search upgrades, license banner
  subscription, settings polish, brand cache, API key UI, richer progress
  inference
- `src/renderer/style.css` — confidence dot, summary bar, conf pills,
  feedback modal, what's-new list, onboarding steps, sample-hint,
  license banner, modal-md size, link-btn
- `src/services/claude.js` — `resolveApiKey()` with user-key priority,
  `resetClient()` exported
- `assets/samples/README.md` — placeholder for sample-spec.pdf
