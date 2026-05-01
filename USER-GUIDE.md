# Substitution Request Generator — User Guide

**(Codename: Skyfall) — For end users — 2026-04-22**

This tool automates the drafting of product substitution requests
against manufacturer catalogs. Extract the original spec, match
against the catalog, draft the request — all in one pass.

---

## Before you start

**You'll need:**
- The Substitution Request Generator installed on your Mac or
  Windows computer (see `INSTALLATION.md`)
- A spec PDF or section of spec text that contains the product
  you want to substitute against
- An internet connection

**You won't need:**
- A login — the app runs entirely on your computer
- Manual catalog lookup — the tool pulls the catalog automatically
  from the cloud-hosted reference data

---

## Workflow

### 1. Launch the app

Double-click the Substitution Request Generator icon in
Applications (Mac) or Start menu / desktop (Windows). The app opens
to the main workflow view.

### 2. Upload the spec excerpt or section

Click **Upload Spec** and select the PDF (or specific pages) with
the specification content you want to substitute against.

Alternatively, paste the spec text directly into the text area if
you don't have a clean PDF excerpt.

### 3. Review extracted roofing products

The app reads the spec text and extracts the **originally-specified
product(s)** — manufacturer, product family, model number(s),
performance characteristics called out in the spec.

You'll see a side panel listing what was extracted:

- Manufacturer name
- Product line / family
- Model / SKU
- Key specifications (weight, thickness, ASTM class, granule type,
  etc.)

**Review for accuracy.** If something looks wrong, edit directly
or re-run extraction with clearer input.

### 4. Match against the catalog

Click **Match Against Catalog**. The tool searches the Soprema
catalog (or whatever catalog is configured) for products that match
the specified properties.

You'll see a ranked list of candidate substitutions with:

- Product name and SKU
- Why it matches (specific property alignment: ASTM class, weight,
  color, etc.)
- Delta from spec (any differences worth noting)
- Confidence score

**Review the matches.** Often the top match is correct; sometimes
you'll want to select a different one (e.g., if your inventory has
a specific SKU on hand).

### 5. Generate the substitution request

Click **Generate Request** after selecting your preferred
substitution. The tool drafts a full substitution request document
with standard sections:

- **Project information** (fill in project name, architect, GC —
  stored for reuse)
- **Original specified product** (auto-filled from extraction)
- **Proposed substitution** (auto-filled from match)
- **Technical comparison** (auto-generated table showing spec-by-spec
  equivalence or improvement)
- **Justification** (auto-drafted prose explaining why the
  substitution meets or exceeds the original spec's intent)
- **Supporting documentation** (links to the proposed product's
  data sheets and any relevant certifications)

### 6. Review and edit

The generated request is a draft. Review:

- **Project information** — fill in the blanks if not auto-populated
- **Justification prose** — edit to match your voice and
  project-specific context
- **Technical comparison** — verify any borderline property
  comparisons

Common edits:
- Adjusting the justification to reference specific architect /
  code considerations
- Adding additional rationale (e.g., availability, lead time,
  regional manufacturing)
- Removing sections that don't apply to the specific project

### 7. Export

You have two export options. Most reps will use the second one.

**Export as PDF.** Saves only the substitution request form as a
single PDF (typically 4–6 pages). Use this when the architect has
already requested the form by itself or when you want to attach
datasheets separately.

**Download full package.** Saves the complete submission package
as a single PDF, ready to email to the architect. Includes:

1. **Cover letter (page 1)** — formal letter on Soprema letterhead,
   addressed to the architect, listing every proposed substitution
   plus a transparency note quoting the data-sources count
   ("Of 21 performance requirements evaluated, 9 verified directly
   against Soprema's published catalog data...").
2. **Substitution request form (next 4–6 pages)** — the property-
   by-property comparison from Step 6, with citations and
   compliance markers.
3. **Soprema datasheets (rest of the document)** — every Soprema
   product data sheet that supports a proposed substitution,
   fetched from Soprema's library and merged in original layout.

The full package is typically 20–30 pages and 1–3 MB. The PDF
includes a clickable bookmark/outline so the architect can jump
directly to any section. Open it in Preview or Acrobat and you'll
see the navigator on the left.

After clicking, a save dialog asks where to save the file. Default
filename: `Submission-Package-[SpecSection]-[ProjectName].pdf`.

The first time you bundle, allow 5–15 seconds for the datasheets
to download from Soprema's library. The button shows
"Building bundle (N datasheets)…" while it works. If a datasheet
fetch fails for any reason, the bundle is still produced with the
remaining content and the failure is named in the success dialog.

Send via your normal channels (email to architect / GC, upload to
the project's document management system, etc.).

### 8. Save the session (optional)

Click **Save Session** to save the state of your work (extracted
product, selected match, drafted request) for later reference or
reuse.

---

## Tips

**Best inputs:**
- Clean spec excerpts (one section of the spec, not the entire
  project manual) produce the best extractions
- Highlight the specific product being referenced if the spec
  lists multiple alternates

**Catalog freshness:**
- The catalog is pulled from the cloud on each launch (or from local
  cache if offline). If you need to force a refresh, quit and
  relaunch.

**When the AI is wrong:**
- Bad extraction → edit the extracted fields manually before
  matching
- Bad match → ignore the top suggestion and pick a better one from
  the ranked list, or search manually with the **Browse Catalog**
  button
- Bad justification prose → edit directly before exporting

**Don't:**
- Don't assume the AI understands your specific project context.
  The drafted justification is a starting point; add your local
  context.
- Don't send without reviewing. This is a tool that accelerates your
  work, not a substitute for your professional judgment.

---

## Keyboard shortcuts

- `Cmd/Ctrl + S` — Save session
- `Cmd/Ctrl + E` — Export to PDF
- `Cmd/Ctrl + N` — New session (clears current)
- `Cmd/Ctrl + R` — Re-run match against catalog

---

## Getting help

Questions, bugs, feature requests: `support@007technologies.com`

Expected response time: within 1 business day.
