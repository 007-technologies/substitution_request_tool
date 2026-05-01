# Sample specs

Drop a curated roofing spec PDF here as **`sample-spec.pdf`**. When Cipher
launches and finds this file (resolved at `assets/samples/sample-spec.pdf`),
the upload screen surfaces a "Try with a sample spec" affordance under the
dropzone — letting prospects on a fresh install demo the tool without
needing to bring their own spec.

## Sizing guidance

The whole `assets/samples/` directory is bundled with the installer (see
`package.json` → `build.files: ["assets/**/*"]`). Keep the sample under
**8 MB** — Cipher installs are already heavy with electron + datasheets,
and Davis is on metered Soprema-issued hardware.

## Rotation policy

Swap in a fresh sample whenever the catalog or product mix shifts
materially. Older samples that no longer reflect current Soprema offerings
make the demo feel stale. Reed reviews quarterly.

## Telemetry

When a user clicks "Try with a sample spec," the standard `spec_uploaded`
event fires with the sample's filename in `metadata.fileName`, so the
admin dashboard surfaces sample-driven analyses without needing a separate
event type. (Filter by `customer_id LIKE 'demo-%'` to isolate prospect
trial sessions if multi-tenant ships.)
