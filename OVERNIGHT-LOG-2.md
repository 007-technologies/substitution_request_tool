# Overnight Log — 2026-04-23

Second overnight Skyfall push. First was the splash/sidebar/redesign
foundation. This one filled in the Library, Help, Settings, and the
AI query bar, plus alignment/hyperlink polish.

## Ship checklist (5-min smoke test)

Run `npm start` from `Skyfall/` and walk through:

1. **Splash** — helix animates, "007" is the hero, "Substitution
   Request Generator" is the subtitle, "Click to continue" is dark and
   readable, footer LLC line is slightly lighter.
2. **007 mark hyperlink** — top-left "007 Technologies" in the sidebar
   opens `https://007technologies.com` in your default browser.
3. **Session step alignment** — the "01 / Upload specification" label
   on the intake screen sits roughly on the same row as "01 Upload" in
   the sidebar. Same for 02/03/04 as you progress.
4. **Analyze flow** — pick a PDF, hit Analyze. Sidebar advances 01 →
   02 (pulsing crimson dot) → 03 as analysis completes. The content
   header swaps from "01 Upload specification" to "02 Analyze
   specification" and back.
5. **AI query bar** — below the match table on the results screen,
   above Step 3. Expand it, click a suggestion chip, hit enter on a
   custom question. Answer comes back in 2–4 sentences from Claude
   Haiku.
6. **Save draft** — in Step 3, fill in Project Name, click the new
   "Save draft" button next to Generate. Toast turns to "Draft saved
   ✓". Sidebar Drafts item shows a red badge with "1".
7. **Library · Recent Sessions** — click the sidebar item. Shows all
   saved analyses with search. Restore opens the analysis at Step 3.
8. **Library · Catalog** — click. Searchable grid of all Soprema
   products from the R2 catalog.
9. **Library · Saved Drafts** — click. Shows the draft you saved.
   Click Resume to reopen with the form pre-filled.
10. **Help · User Guide** — click. Renders `USER-GUIDE.md` inline
    with proper typography. Links open externally.
11. **Help · Support** — click. Opens `mailto:support@007technologies.com`
    with a prefilled subject.
12. **Settings** — click. Shows version, Electron/Node, data folder
    path, logs folder path. "Reveal in Finder" opens the folders.
    "Clear all history" nukes `sessions.json` and `drafts.json`.

## What shipped

### Renderer

- `src/renderer/index.html` — added:
  - Sidebar brand as `<a>` to 007technologies.com.
  - SVG icons + badges for all Library / Help / Settings items.
  - Full Library sections: Recent, Catalog, Drafts.
  - Help · User Guide inline reader section.
  - Settings section with Version / Data folder / Logs folder /
    Clear history cards.
  - AI query bar component between Step 2 (match table) and Step 3
    (generate), with collapsible header, suggestion chips, input +
    submit, and message thread.

- `src/renderer/app.js` — added:
  - Expanded `showSection()` to handle 9 top-level sections
    (upload, loading, error, results, library-recent,
    library-catalog, library-drafts, help-guide, settings).
  - `SECTION_TO_NAV` + sidebar nav active-state toggling.
  - 007 brand link → `window.api.openExternal` (safe: main.js
    allow-lists `http(s)` and `mailto` only).
  - Recent Sessions full-view controller (search, restore, delete;
    uses the same `sessionCache` that powers the inline history).
  - Catalog controller (one-shot load from `getCatalogProducts`,
    client-side filtering).
  - Drafts controller (save / resume / delete + badge).
  - User Guide renderer — minimal pure-JS markdown parser (headings,
    bold, italic, inline code, fenced blocks, lists, links, HR).
    Links open externally via `data-external` attribute.
  - Settings controller — loads `getAppInfo`, wires reveal +
    clear-history actions.
  - AI query bar — Haiku-powered Q&A, suggestion chips, typing
    indicator, history-aware follow-ups (last 6 turns).
  - "Save draft" button injected next to the Generate button at
    startup. Persists via `saveDraft` IPC.
  - `resetAnalysisEphemeralState()` clears draft-id + query thread
    on Analyze click and "New analysis" click.

- `src/renderer/style.css` — added ~700 lines:
  - Section top-padding of 96px on upload/results/error/library so
    the content header visually aligns with the sidebar's first
    Session item.
  - `.sidebar-brand` as `<a>` with no underline + hover opacity.
  - `.sidebar-nav`, `.sidebar-nav-icon`, `.sidebar-badge` + active
    state with amber inset shadow (crimson is for Session steps, so
    the nav items get amber to distinguish them).
  - Full `.query-bar` component: collapsible header, amber→crimson
    gradient spark icon, suggestion chips, input row, message
    thread with user/assistant bubbles, typing indicator animation.
  - `.library-section`, `.library-toolbar`, `.library-search`,
    `.library-card`, `.catalog-card`, `.library-catalog-grid`.
  - Help guide prose styles (headings, paragraphs, code, links).
  - Settings grid + cards (incl. danger variant).
  - Section fade-in animation on all top-level sections.

### Main + services

- `src/main/preload.js` — exposed new IPC:
  `openExternal`, `askQuestion`, `saveDraft`, `loadDrafts`,
  `deleteDraft`, `readUserGuide`, `getAppInfo`, `revealInFinder`,
  `clearHistory`.

- `src/main/main.js` — added handlers for all of the above:
  - `open-external` — allow-lists `http(s)` and `mailto:` URLs before
    calling `shell.openExternal`.
  - `ask-question` — delegates to `askQuestion` in `services/claude.js`.
  - `save-draft` / `load-drafts` / `delete-draft` — JSON file at
    `dataDir/drafts.json`, capped at 25 drafts.
  - `read-user-guide` — reads `Skyfall/USER-GUIDE.md` in dev;
    falls back to `resourcesPath/USER-GUIDE.md` in packaged builds.
  - `get-app-info` — version, electron/node, paths.
  - `reveal-in-finder` — `shell.showItemInFolder` with fallback.
  - `clear-history` — deletes sessions.json + drafts.json.

- `src/services/claude.js` — added:
  - `askQuestion(question, { extracted, matched, history })` — uses
    `claude-haiku-4-5-20251001`, 1500 max_tokens, strips citation
    data from context to keep it lean, supports multi-turn via
    history slice.

## Smoke-test gotchas

- **USER-GUIDE.md isn't in packaged builds yet.** The `read-user-guide`
  handler handles this gracefully (shows an "unavailable" empty state)
  but before the next Soprema build, add `"USER-GUIDE.md"` to the
  `extraResources` array in `package.json` under `build`. Dev mode
  already works because it falls back to the source path.
- **Support email `support@007technologies.com`** — this alias may not
  exist yet. If it bounces, add it in Cloudflare Email Routing or
  Google Workspace, or change the address in `app.js` (search for
  `openSupport`).
- **Drafts are local-only.** No sync across machines yet. Fine for
  pilot but flag for multi-tenant roadmap.
- **Catalog loads once per session.** Cached in renderer memory. If
  you update the R2 catalog, restart the app to refetch.
- **Query bar shows only when results are visible.** On splash or
  upload, it stays hidden. That's intentional — nothing to query
  against until an analysis completes.

## Known small rough edges (left for Davis-feedback pass)

- Match-card styling still uses the old grid layout. Post-Davis I'll
  redo the match/compare UI per his feedback.
- Step 3 form still has the old Microsoft-blue button. Not touched
  because the whole Step 3 preview is about to get reworked.
- No syntax highlighting in the help-guide code blocks. Trivial to
  add later if you want it.
- Error section still uses the inherited "!" number — if that bothers
  you I can swap for a crimson dot or "⚠".

## What I didn't touch

- `package.json` — requires Reed's permission per CLAUDE.md rules.
- `config.json` / credentials — untouched.
- `Spectre/` — referenced only (read-only) to port the query-bar
  pattern.
- Any git operations.

## Top priorities for Reed on wake-up

1. **Smoke test the 12 items above** — takes 5 min end-to-end.
2. **If Query Bar feels off** — tell me whether the suggestion chips
   are hitting real roofer questions. I guessed based on Soprema's
   domain but haven't validated with Davis yet. Easy to edit the
   `data-q` attributes in `index.html`.
3. **If Library feels over-built** — I can simplify. Recent Sessions
   + Drafts are natural; Catalog might be scope-creep for the pilot
   since the user never directly browses it (the matcher does).
4. **Davis call** — Zoom on Thu 4/23 or Fri 4/24. This build gives
   you new surface area to demo if the time permits (sidebar, query
   bar, drafts, settings). Don't feel obligated to show it all — the
   match table is still the pilot hero.

---

Tasks #94, #95, #96 marked complete. #97 (this task) closes on
handoff-doc commit.

Next session:
- Wait on Davis feedback
- Resolve LLC member structure (#22)
- Attorney retention + insurance binding (Phase 0.5)

Signing off.
