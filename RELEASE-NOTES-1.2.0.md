# Soprema Substitution Tool — v1.2.0

**Release date:** 2026-04-26
**Theme:** Full submission package — one click, complete deliverable

## What's new

Skyfall no longer generates just a substitution request. It generates the
*complete submission package* an architect needs to evaluate the
substitution: cover letter on Soprema letterhead, the property-by-property
comparison form, and every Soprema product datasheet, all merged into a
single PDF with clickable navigation.

Previously, a Soprema rep finishing a Skyfall sub-request would still have
to: pull each PDS from R2, assemble them in order, write a cover letter,
merge everything into one document, and email it to the architect. That
~hour of manual assembly is now one click.

## The new "Download full package" button

Click it, and Skyfall produces a single PDF containing:

1. **Cover letter** (page 1) — formal letter on Soprema letterhead with the
   submitter's name, addressed to the architect, listing every proposed
   substitution and the data-sources summary upfront.
2. **Substitution Request Form** (pages 2–6 typically) — the same
   property-by-property comparison from v1.1.0, with citations,
   compliance markers, and footnotes.
3. **Soprema product datasheets** (pages 7+) — every Soprema PDS that
   supports a proposed substitution, fetched from Soprema's CDN and
   merged in original layout (with full color, photography, and
   formatting preserved).

Total bundle is typically 20–30 pages, 1–3 MB, ready to email.

## Cover letter

The cover letter is generated automatically from the project info the user
already enters at the bottom of the form (project name, spec section,
addressed-to, submitted-by). No additional form fields, no extra Claude
call. The letter is template-driven and includes:

- Soprema-branded letterhead with the spec section in the tagline
- Date (today's, or whatever date the user entered)
- Addressee block
- Subject line: "Re: [Project] — Substitution Request, Spec Section [###]"
- Opening paragraph explaining the methodology
- Bulleted list of every proposed substitution: "[Spec product] → Soprema
  [matched product]"
- **Data-sources sentence** — quotes the actual counts: "Of [21]
  performance requirements evaluated: [9] verified directly against
  Soprema's published catalog data; [10] flagged with industry-standard
  reference values pending PDS verification; [2] marked for direct
  verification (no published Soprema data)."
- Closing paragraph and signature block parsed from the submitter field

When the spec extractor returned an empty product_name (e.g. "GAF — :"),
the cover letter falls back to product_type or specifications text rather
than rendering a trailing space.

## Clickable PDF outline

The merged PDF includes a bookmark/outline for each section, so an
architect opening the document in Preview, Acrobat, or any modern PDF
reader sees a left-rail navigator like:

```
Cover Letter
Substitution Request
SOPRA ISO
SOPRA ISO TAPERED
DEXCELL FA Glass Mat Roof Board
104 ASPHALT PRIMER
DUOTACK 365
SOPRAFIX FASTENER 12 DP
ALSAN RS 230 FIELD
```

Clicking any entry jumps directly to that section's first page.

## Internal

- Added `pdf-lib` dependency (~2MB pure-JS PDF manipulation library)
- New IPC handler `export-bundle-pdf` in main.js
- New helper `fetchUrlBuffer(url)` in r2.js for fetching PDS files from
  Soprema's CDN at `my.assets-library.com` (PDFs don't actually live
  in R2 — only metadata does)
- New `getDocumentUrlByFilename` lookup in catalog.js for resolving a
  matched datasheet's filename to its real URL
- `addPdfBookmarks` helper builds the PDF outline tree at merge time
  using pdf-lib's low-level context API
- New `buildCoverLetterHTML` function in app.js renderer
- New `exportBundlePDF` API on the preload contextBridge

## UI cleanup

Removed all decorative emojis from the UI per Davis's feedback that the
output should look like an engineering document, not a software UI:

- Sidebar menu: no folder/file/wrench icons
- Datasheet links: no paperclip emoji
- Empty states: no magnifying-glass or X icons
- Query bar: no sparkle icon
- Buttons: no envelope or package emoji prefixes

Kept only:
- Compliance ✓/✗ marks in the property comparison table — these are the
  AIA/CSI standard substitution-form notation, not decoration
- SVG arrow icons for directional UI (submit, expand) — not emojis,
  semantic affordances

## Bug fixes from earlier in v1.1.0 series

(carried forward — not new in v1.2.0 but worth noting since v1.0.0
shipped to Davis is the comparison point)

- Property comparison rebuild — every spec requirement now gets its own
  row with units, standards, citations, compliance check
- Catalog enriched with structured property data from 335 Soprema PDSes
  (95.4% coverage)
- Chemistry-aware matching — DUOTACK 365 (polyurethane foam) correctly
  picked for OlyBond 500, not COLPLY EF (silyl-polyether membrane
  adhesive)
- Strict-range compliance evaluation — when an industry-standard range
  straddles the spec threshold, compliance reads "?" (architect-verifiable)
  rather than confidently ✓ or ✗
- Test-method conflation guard — won't pull water_absorption (% per
  ASTM D994) as the answer to a spec asking for surface_water_absorption
  (grams per ASTM C473)
- Range aggregation — products with min/max paired properties show as
  "1-4 in" instead of misleading single-bound "1 in"
- Product designator preservation — DEXCELL FA picked over DEXCELL when
  the spec called for the FA variant
- General-knowledge allowlist — fills industry-universal values (Class A
  fire on glass-mat coverboard, ~6 R/inch on polyiso, 10/10 mold
  resistance) with verification notes rather than blank cells
- Token cost logging in DevTools console for cost-per-iteration tracking

## Upgrade path

Davis (and any other v1.0.0 / v1.1.0 users) will receive this update via
electron-updater on next launch. No reinstall needed.

## Known limitations

- Bundle merging requires fetching each PDS over HTTPS at export time
  (Soprema's CDN). On a slow network, a 7-datasheet bundle takes 5–15
  seconds to assemble. If a datasheet fetch fails, the bundle is still
  produced with the remaining content and the failure is surfaced in
  the success dialog.
- Bookmark titles are derived from PDS filenames (with "PDS-" prefix
  and ".pdf" extension stripped). Some filenames produce slightly less
  readable titles than ideal — future polish item.

## Next up

- Spec-section opportunity scanner (proactive substitution finder across
  full spec, not just one section)
- Architect comment workflow (paste architect's reply, get suggested
  response drawn from spec + Soprema data)
- Project portfolio dashboard for the rep (pending sub-requests, win
  rates, common rejection reasons)
- Real Soprema branding refinements (Soprema logo on header, AIA G716
  numbering)
