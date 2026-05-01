# Skyfall — Technical Debt Audit

**2026-04-22**

Read through of the Skyfall codebase for technical debt, listed by
priority. Not comprehensive but actionable.

---

## High priority

### 1. Single embedded API key (scaling limit)

**Issue:** `config.json` contains one `ANTHROPIC_API_KEY` and one
set of R2 credentials shared across every install.

**Impact:** Can't isolate customer usage. Can't revoke one
customer's access without rebuilding and redistributing to all.
Scales poorly past 2–3 customers.

**Fix:** Implement multi-tenant build-time key injection per
`Shared/multi-tenant-architecture.md`.

**Effort:** 2–3 days.

### 2. No error telemetry in production

**Issue:** When Davis's install throws an error, we find out when
Davis emails us. No stack traces, no context, no aggregation.

**Fix:** Integrate Sentry per `Shared/telemetry-integration-plan.md`.

**Effort:** 2 hours.

### 3. No usage analytics

**Issue:** We don't know if Davis is actually using the tool, how
often, which features. Flying blind.

**Fix:** Integrate PostHog per the same plan.

**Effort:** 2 hours.

### 4. Git repo structure corruption (from earlier session)

**Issue:** Git's index historically had bogus deeply-nested paths
(`src/main/src/main/...`) — resolved 2026-04-21 via the fix plan.
Source of the original corruption is unclear; future `git mv`
operations could reintroduce.

**Fix:** Prefer `git mv` over manual moves; audit after any
restructuring. Add a pre-commit hook (optional) that warns on
pathnames with repeated path segments.

**Effort:** 30 minutes if a pre-commit hook is added.

---

## Medium priority

### 5. Build targets Mac only

**Issue:** `package.json` has `"build": "electron-builder --mac"`.
Windows installers are generated but only when run on a Windows
build machine or via Wine on Mac — not automated.

**Fix:** Add a `build:all` script that runs `--mac --win`. Document
prerequisites (Wine install for Mac-based Windows cross-compile).

**Effort:** 1 hour.

### 6. No build:win validation

**Issue:** Windows .exe builds currently happen via Wine on Mac.
Works but fragile. Build signatures may not validate on some
Windows installs.

**Fix:** Set up a proper Windows build via GitHub Actions (free for
public repos; need to check private-repo minutes for the org).

**Effort:** Half day to set up CI.

### 7. Electron-updater unsigned builds

**Issue:** Neither Mac nor Windows builds are code-signed. Users
see Gatekeeper / SmartScreen warnings on first install. Auto-update
may not function correctly for unsigned apps on newer macOS.

**Fix:** Purchase Apple Developer ID ($99/year) and Windows
code-signing cert (~$200/year). Wire into the build process via
`electron-builder` signing config.

**Effort:** 1 day including cert acquisition + integration.

### 8. Data folder sessions.json contains user state

**Issue:** `data/sessions.json` is ~75 KB of session data. Shipping
it in builds isn't appropriate — it's per-user state. Already
gitignored, but the local folder can grow unbounded.

**Fix:** Add session cleanup — prune sessions older than 90 days
at launch. Or move session state into Electron's `userData`
directory (`app.getPath('userData')`) where it belongs.

**Effort:** 2 hours.

### 9. Catalog loading has no local cache fallback

**Issue:** `catalog.js` calls `fetchMetadata` from R2 on every
launch. If the user is offline, the app fails to load.

**Fix:** Cache the catalog locally after first successful fetch.
Use cached version if the network request fails. Invalidate cache
on version bump or after 7 days.

**Effort:** 3 hours.

### 10. AWS SDK v3 is large

**Issue:** `@aws-sdk/client-s3` is multiple MB in the bundle. Most
of its surface area is unused; only need object fetching.

**Fix:** Switch to a lightweight S3 client (e.g., native `fetch`
with AWS signature v4 via a small package). Alternatively, use
Cloudflare R2's S3-compatible HTTP API directly with basic
signing.

**Effort:** 1 day including testing.

---

## Low priority

### 11. No tests

**Issue:** No unit tests, integration tests, or end-to-end tests.
Regressions catch only at user-reported bug time.

**Fix:** Add Jest + a minimal test suite. Start with the critical
paths: catalog loading, extraction, matching, request generation.

**Effort:** 2–3 days to establish framework + initial tests.

### 12. Hardcoded strings everywhere

**Issue:** UI text is inlined in HTML and JS. No internationalization
path. Not urgent for US-only customers but limits future.

**Fix:** Extract strings to a constants file / i18n system only when
a non-English customer materializes. Don't over-build.

**Effort:** Don't do yet.

### 13. Error messages in friendlyError() could be more specific

**Issue:** `friendlyError()` in main.js catches broadly ("Too many
requests — please wait"), but doesn't surface which request failed
or how long to wait.

**Fix:** Add request-level error context; log full error to Sentry
while showing friendly summary to user.

**Effort:** 3 hours.

### 14. package.json publish config previously wrong

**Issue:** (Fixed 2026-04-22) `publish.repo` was `substitution-request-tool`
(hyphens) but actual repo is `substitution_request_tool` (underscores).
Auto-updater would have silently failed.

**Fix:** Already corrected.

**Status:** Done.

### 15. Renderer + main process have no security review

**Issue:** Electron apps require careful handling of preload,
context isolation, node integration. Haven't done a formal review
of Skyfall's security posture at the Electron-configuration level.

**Fix:** Review `webPreferences` in main.js. Confirm:
- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true` where possible
- No unsafe-eval CSP

**Effort:** 2–3 hours.

---

## Nice to have (someday)

- Dark mode toggle
- Drag-and-drop file support in addition to file picker
- Keyboard shortcuts for common actions
- Collapsible sections in the review UI
- Bulk actions on catalog matches
- Export to formats beyond PDF (DOCX, markdown)
- Screenshot on error submission
- Auto-save session state every N minutes (vs. on-demand save)

---

## Summary

If I had to pick the **three** things to address next (in order):

1. **Multi-tenant build-time keys** — unblocks scale past 2
   customers (high impact, medium effort)
2. **Sentry + PostHog telemetry** — production visibility (high
   impact, low effort)
3. **Local catalog cache** — fixes offline launch fragility (medium
   impact, low effort)

The rest can wait.
