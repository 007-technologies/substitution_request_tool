# Product Comparison rebuild plan

Davis's "missing the meat" feedback — diagnosed, scoped, ready to execute.

---

## What I found after reading the three prompts + catalog service

**The architecture problem is real, not just a prompt problem.**

### Extract prompt (`extract.txt`)
Pulls a free-form `specifications` **string** per product — "thickness, R-value, fire rating, ASTM standards, weight, psi, etc." — not a structured array of numerical properties. Loses the numerical values on ingest.

### Match prompt (`match.txt`)
Passes a `key_specs` **string** back, not structured properties. So even if the extract step had numerical values, they'd get re-stringified here.

### Sub-request prompt (`subrequest.txt`)
Asks for `comparisonPoints` with `{ attribute, specified, proposed, compliant }`. That shape is right, but because the upstream steps never pass structured numerical data, Claude has to hallucinate values or stay generic. Output ends up reading as narrative instead of evidence — which is exactly Davis's complaint.

### The Soprema catalog (R2 → `condensedCatalog`)
`catalog.js → buildCondensedCatalog()` keeps: `id, name, application, role, astm, type, grade, material, top_surface, bottom_surface, categories, collections, family`.

It does NOT currently surface: tensile strength, thickness, weight, fire rating class, wind uplift rating, warranty years, peel strength, cold-flex, service temp range.

**Possible hidden upside:** the raw `products` array from R2 might have more fields than the condenser exposes. `buildCondensedCatalog` may be dropping property data we could use. Need to verify.

---

## Two-tier fix

### Tier 1 — Weekend-doable, ~70–80% of the way to Davis-grade

1. **Rewrite `extract.txt`** to emit structured properties per product:
   ```json
   "performance_properties": [
     { "property": "tensile_strength_md",
       "required_value": "200",
       "unit": "lbf/in",
       "standard": "ASTM D5147",
       "comparator": ">=" },
     { "property": "fire_rating",
       "required_value": "Class A",
       "unit": null,
       "standard": "ASTM E108",
       "comparator": "=" }
   ]
   ```
   Claude is good at extracting these from spec text — the spec almost always has "minimum tensile strength: 200 lbf/in per ASTM D5147" or similar.

2. **Expand `buildCondensedCatalog()`** in `catalog.js` to include every available property field from the raw Soprema catalog. If there's no property data in the catalog, add a fallback where Claude uses its general knowledge of Soprema products (SOPRALENE, SOPRASTICK, SOPRASEAL, etc.) to fill in — marked with a footnote "verify against product data sheet" for any value Claude isn't 100% sure of.

3. **Rewrite `match.txt`** to return structured `soprema_properties` for each matched product — same shape as the spec's `performance_properties`. Matcher's job becomes: for every property the spec requires, state Soprema's value in the same units.

4. **Rewrite `subrequest.txt`** — replace narrative-heavy `differences` field with a required `property_comparison` table:
   ```json
   "property_comparison": [
     {
       "property": "tensile_strength_md",
       "standard": "ASTM D5147",
       "unit": "lbf/in",
       "spec_required": "200 min",
       "soprema_provides": "215 typical",
       "compliant": true,
       "confidence": "from_datasheet|from_general_knowledge|needs_verification"
     }
   ]
   ```

5. **Rewrite `buildSubRequestHTML()` in `app.js`** to render this as a real table — property | standard | spec required | Soprema provides | compliant ✓/✗ — with footnotes for any row where confidence is `needs_verification`.

6. **Same update to `buildPrintableHTML()`** so the exported PDF shows the same table.

**Risk:** Tier 1 still has some hallucination risk on Soprema values if the catalog doesn't have property data. We mitigate by flagging low-confidence rows, not by pretending.

### Tier 2 — Real fix, ~1–2 days of work

Enrich the Soprema catalog with structured property data. Options:

- **(a) Ask Soprema for a structured data feed.** Davis or his technical team almost certainly has this internally — they use it for their own literature. Cleanest path, zero hallucination.
- **(b) Parse Soprema's PDS (Product Data Sheet) PDFs once.** Write a one-time script that reads every datasheet in R2, extracts performance properties via Claude, saves a structured `properties.json` alongside each product. Reuse that file forever.
- **(c) Hybrid: ship Tier 1 now, build (b) this month as background work.** Most pragmatic.

---

## What I need from you to start Tier 1

**One thing, 5 minutes:**

Run the Skyfall app once, open DevTools on the main process (or add a `console.log(products[0])` temporarily in `catalog.js` line 10 inside `loadCatalog`), and paste me the output of one raw product from R2. I want to see what property fields actually exist on the raw catalog items before I rewrite `buildCondensedCatalog`. Depending on what's there, this rebuild is either:

- **1 day of work** (if there are property fields I can expose)
- **2 days + catalog enrichment** (if there isn't and we need the Tier 2 fix)

Either way, I can get started on the prompt rewrites and the HTML rebuild now with placeholder assumptions — you slot the real catalog data in when you send it.

---

## Scope decision

Tier 1 for Davis's Tuesday email regardless. Even at 70–80% Davis will see the structural fix — tabulated, not narrative — which is the piece he actually flagged. Full accuracy can be Tier 2 once he confirms the structure is right.

**My strong recommendation:** don't wait for full catalog enrichment before showing Davis the new format. Ship structural fix Monday, show him on Tuesday, iterate from there. If the structure is wrong we save ourselves a week of catalog work.

---

Last updated: 2026-04-24
