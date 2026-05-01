# Soprema Substitution Tool — v1.1.0

**Release date:** 2026-04-25
**Theme:** Property-by-property comparison (the "show your work" release)

## What's new

The substitution request output is no longer narrative prose. Every spec
requirement now gets its own row in a property comparison table with the
spec value, the Soprema value, a compliance check, and a citation back to
the source spec. The architect can read down the table and verify each
claim without leaving the page.

Example, before:

> Soprema's SOPRA-ISO is a polyisocyanurate insulation that meets or
> exceeds all the spec requirements. Compressive strength, density, and
> dimensional stability are all in line with the specified product.

Example, after:

| Property             | Standard     | Spec required | Soprema provides | Compliant | Cite |
|----------------------|--------------|---------------|------------------|-----------|------|
| Compressive Strength | ASTM C1289   | 20 min psi    | 20-25 psi        | ✓         | p. 8 |
| Density              | ASTM C1289   | 2.0 min pcf   | 2.0 pcf          | ✓         | p. 8 |
| Minimum Thickness    | HH-I-1972/1  | 2 min in      | 1-4 in           | ✓         | p. 8 |

## Specific improvements

- **Catalog enrichment.** Every Soprema product's PDS has been parsed
  offline by Claude Haiku into structured property data (335 of 351
  products successfully enriched, 95.4% coverage). The matcher now
  draws actual numerical values from the PDS, not approximations.

- **Chemistry-aware matching.** The matcher now distinguishes
  polyurethane foam adhesives (DUOTACK 365) from silyl-polyether
  membrane adhesives (COLPLY EF) and from PMMA primers (ALSAN RS 222)
  vs PMMA topcoats (ALSAN RS 230 FIELD). Substitutions can no longer
  cross chemistry families silently.

- **Fastener properties extracted.** Thread diameter, thread count,
  corrosion resistance class, and head style now appear in the
  comparison table for fastener substitutions. Previously buried in
  prose.

- **Range aggregation.** Products available in multiple thicknesses
  (or other ranges) now show as "1-4 in" instead of just "1 in" —
  which previously confused the compliance check.

- **Citations on every row.** Every property comparison row carries
  the page number and a verbatim quote from the spec for the
  architect to verify.

- **Verification footnotes.** When the catalog doesn't publish a
  specific property (e.g. Class A fire rating on a coverboard), the
  row carries a footnote pointing to the current product datasheet
  rather than inventing a number.

## Substitution request structure

The output now matches AIA/CSI standard substitution request format:

- Form metadata (project, spec section, date, addressed to)
- "Products being substituted" (the originally specified products)
- "Proposed substitution" sections (one per spec product)
  - Manufacturer, product name, product ID
  - Description + reason for substitution
  - Property-by-property comparison table
  - Affected drawings / spec sections
  - Supporting documentation
- Footnotes
- Submission notes
- Certification statement

## Bug fixes

- Manufacturer field no longer reads "Unknown" for industry-standard
  commodity products (e.g. ASTM D 312 Type IV hot asphalt). Now reads
  "Industry Standard."
- Fixed JSON parse failures on long extractions (raised max_tokens
  16K, added robust 3-attempt parser for trailing commas and control
  chars).
- Fixed rate-limit errors on catalog enrichment (reduced parallelism
  to 2, added retry-with-backoff using the API's retry-after header).
- Fixed "prompt too long" errors on specs with 8+ products (per-
  category candidate filtering, property dedupe by name).

## Internal

- Token cost logging on every Claude call (DevTools console).
  Helpful for tracking iteration costs during pilots.
- Named-anchor force-include in catalog filter — DUOTACK 365,
  SOPREMA #12 DP FASTENER, DEXCELL FA, ALSAN RS field, and other
  pilot-critical products are guaranteed to appear in the matcher's
  candidate list regardless of relevance score.

## Known limitations

- DUOTACK 365's enriched properties cover application/handling
  attributes (viscosity, cure time, VOC) but not cured-foam mechanical
  attributes (density, compressive, tensile, R-value). Comparison
  table flags these for verification against the current PDS.
- DEXCELL FA Glass Mat coverboard is enriched with thickness, weight,
  compressive, water absorption — but not fire classification,
  permeance, or mold resistance. Future enrichment pass will add
  industry-standard defaults for these with verification notes.
- Fake test PDFs cluster citations on a few pages. Real-world specs
  with diverse section locations have not been pilot-tested yet.

## Upgrade path

Davis (and any other v1.0.0 users) will receive this update via
electron-updater on next launch. No reinstall needed.
