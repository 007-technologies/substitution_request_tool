#!/usr/bin/env node
/* ============================================================
   Skyfall — Catalog enrichment script
   ============================================================
   One-time (or periodic) script that reads every Soprema
   Product Data Sheet (PDS) in R2, extracts performance
   properties via Claude Haiku, and writes a structured
   `metadata/properties.json` file alongside the existing
   products + documents catalogs.

   Run with:
     node scripts/enrich-catalog.js              # full run
     node scripts/enrich-catalog.js --resume     # resume + skip already-enriched
     node scripts/enrich-catalog.js --limit 10   # only process N products (testing)
     node scripts/enrich-catalog.js --product "SOPRA-ISO"   # only this product

   Cost estimate:
   - Haiku at ~$0.80 / 1M input + $4 / 1M output tokens
   - Average PDS extraction: ~3K input + ~500 output tokens
   - Per-product cost: ~$0.005
   - Full Soprema catalog (~300 products with PDS): ~$1.50

   Output:
   - data/properties.json (local — read by loadCatalog)
   - Use --upload to also push to R2 metadata/properties.json
   ============================================================ */

const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const pdfParse = require('pdf-parse');

const ROOT = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));

// ── Args ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const RESUME = args.includes('--resume');
const UPLOAD = args.includes('--upload');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 ? parseInt(args[i + 1], 10) : null;
})();
const FILTER_PRODUCT = (() => {
  const i = args.indexOf('--product');
  return i >= 0 ? args[i + 1] : null;
})();
// Anthropic Haiku 4.5 default rate limit is 10,000 output tokens/minute.
// Average extraction is ~2-4K output tokens. Parallelism=2 stays well under.
const PARALLELISM = 2;
const SAVE_EVERY = 10;       // save progress every N processed
const MAX_RATE_LIMIT_RETRIES = 4;

// ── Setup ─────────────────────────────────────────────────────────────────────
const claude = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${config.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: config.CLOUDFLARE_ACCESS_KEY_ID,
    secretAccessKey: config.CLOUDFLARE_SECRET_ACCESS_KEY,
  },
});
const BUCKET = config.R2_BUCKET;

const dataDir = path.join(ROOT, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const OUTPUT_FILE = path.join(dataDir, 'properties.json');

// ── R2 helpers ────────────────────────────────────────────────────────────────
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function fetchR2Json(key) {
  const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const body = await streamToBuffer(res.Body);
  return JSON.parse(body.toString('utf-8'));
}

async function fetchR2Buffer(key) {
  const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return streamToBuffer(res.Body);
}

async function uploadR2Json(key, obj) {
  await r2.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(obj, null, 2),
    ContentType: 'application/json',
  }));
}

async function listR2Prefix(prefix, maxKeys = 30) {
  const cmd = new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, MaxKeys: maxKeys });
  const res = await r2.send(cmd);
  return (res.Contents || []).map(o => o.Key);
}

// PDFs live on Soprema's external CDN (my.assets-library.com), not in R2.
// R2 only holds the metadata JSONs.
async function fetchUrlBuffer(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh) Skyfall-CatalogEnricher/1.0',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// ── Claude extraction prompt ─────────────────────────────────────────────────
const EXTRACT_SYSTEM_PROMPT = `You are a roofing materials data analyst. Given a Soprema Product Data Sheet (PDS), extract every numerical and categorical performance property listed.

Return ONLY valid JSON in this exact structure:
{
  "properties": [
    {
      "property": "<snake_case>",
      "value": "<number or category>",
      "unit": "<unit or null>",
      "standard": "<governing standard or null>"
    }
  ]
}

Standard property names to use where applicable: tensile_strength_md, tensile_strength_cmd, tear_resistance_md, tear_resistance_cmd, thickness, thickness_minimum, weight_per_square, weight_per_unit_area, elongation_at_break_md, elongation_at_break_cmd, dimensional_stability, low_temperature_flexibility, service_temperature_range, fire_rating, fire_classification, wind_uplift_rating, water_absorption, peel_strength, puncture_resistance, reflectance_initial, reflectance_aged, sri, r_value, r_value_per_inch, compressive_strength, density, warranty_years_material, warranty_years_labor, warranty_years_ndl, flow_temperature, softening_point, granule_embedment, viscosity, flash_point.

For properties not on this list, use a clear snake_case name based on the PDS terminology.

Rules:
- Do not invent values. If a property is mentioned without a value, skip it.
- For ranges (e.g. "30–50 mil"), use "30-50" as the value.
- For minimums ("≥200 lbf/in"), use "200" as the value and note that it's a minimum in the property name itself if needed.
- Standards should match what the PDS cites (e.g. "ASTM D5147", "FM 4470", "UL 790"). Use null if no standard is cited for that property.
- Be exhaustive — capture every numerical specification on the datasheet.`;

async function callClaudeWithRetry(opts) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    try {
      return await claude.messages.create(opts);
    } catch (err) {
      lastErr = err;
      const is429 = err?.status === 429 || /rate.?limit/i.test(err?.message || '');
      if (!is429 || attempt === MAX_RATE_LIMIT_RETRIES) throw err;

      // Parse retry-after header if Anthropic returned one; default 65s
      const retryAfter = parseInt(err?.headers?.['retry-after'] || '65', 10);
      const waitSec = Math.max(retryAfter, 30) + Math.floor(Math.random() * 10); // small jitter
      console.log(`  ⏸  rate limit hit — waiting ${waitSec}s (attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES + 1})`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
    }
  }
  throw lastErr;
}

async function extractPropertiesFromPDS(productName, pdsText) {
  // PDSes can be long; first 12K chars usually contain all property tables
  const truncated = pdsText.slice(0, 12000);

  const response = await callClaudeWithRetry({
    model: 'claude-haiku-4-5-20251001',
    // Bumped from 2000 — products with 30+ properties were hitting the cap
    // and truncating mid-JSON. 8K leaves comfortable headroom.
    max_tokens: 8000,
    system: EXTRACT_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Soprema Product: ${productName}\n\nProduct Data Sheet text:\n\n${truncated}`,
    }],
  });

  if (response.stop_reason === 'max_tokens') {
    throw new Error(`Truncated at max_tokens — increase the cap (current 8000). Product: ${productName}`);
  }

  const text = response.content[0].text.trim();
  // Strip code fences if present
  let cleaned = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  // Find the outermost JSON object
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON object found in Claude response');
  cleaned = m[0];

  // Robust parse — handle the common Haiku formatting hiccups
  try {
    return JSON.parse(cleaned);
  } catch (e1) {
    // Strip trailing commas before `}` or `]`
    const noTrailing = cleaned.replace(/,(\s*[}\]])/g, '$1');
    try {
      return JSON.parse(noTrailing);
    } catch (e2) {
      // Sanitize unescaped control characters inside string values
      const sanitized = noTrailing.replace(
        /"((?:[^"\\]|\\[\s\S])*)"/g,
        (match, content) =>
          '"' +
          content.replace(/[\x00-\x1F\x7F]/g, (c) => {
            const map = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\f': '\\f', '\b': '\\b' };
            return map[c] || '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
          }) +
          '"'
      );
      return JSON.parse(sanitized);
    }
  }
}

// ── PDS-to-product matching ───────────────────────────────────────────────────
function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[®™©]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function findPdsForProduct(product, pdsDocuments) {
  const productNorm = normalizeName(product.name);
  const productTokens = productNorm.split(' ').filter(t => t.length >= 3);

  let bestDoc = null;
  let bestScore = 0;

  for (const doc of pdsDocuments) {
    const docName = doc.name || doc.url || '';
    const docNorm = normalizeName(docName);

    // Score: count matching tokens, weight longer tokens higher
    let score = 0;
    productTokens.forEach(t => {
      if (docNorm.includes(t)) score += t.length;
    });

    // Bonus if the product's full normalized name appears in the doc name
    if (productNorm.length >= 6 && docNorm.includes(productNorm)) score += 10;

    if (score > bestScore) { bestScore = score; bestDoc = doc; }
  }

  // Require minimum score so we don't match irrelevant docs
  return bestScore >= 4 ? bestDoc : null;
}

// ── Main run ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('🔧 Skyfall catalog enrichment');
  console.log('---------------------------------');

  console.log('▸ Loading products + documents from R2...');
  const [products, documents] = await Promise.all([
    fetchR2Json('metadata/products.json'),
    fetchR2Json('metadata/documents.json'),
  ]);
  console.log(`▸ Loaded ${products.length} products, ${documents.length} documents.`);

  const pdsDocs = documents.filter(d => d.type === 'Product Data Sheets');
  console.log(`▸ Filtered to ${pdsDocs.length} PDS documents.`);

  // ── Inspect mode — diagnose the R2 path situation without fetching anything ─
  if (args.includes('--inspect')) {
    console.log('\n=== INSPECT MODE ===\n');

    console.log('Distinct document type values in catalog:');
    const types = {};
    documents.forEach(d => { types[d.type] = (types[d.type] || 0) + 1; });
    Object.entries(types).sort((a,b) => b[1]-a[1]).forEach(([t, n]) => console.log(`  ${n.toString().padStart(4)} — "${t}"`));

    console.log('\nFirst 3 PDS documents (raw):');
    pdsDocs.slice(0, 3).forEach((d, i) => {
      console.log(`\n  [${i}] ${JSON.stringify(d, null, 2)}`);
    });

    console.log('\nConstructed r2Keys (what the script tries to fetch):');
    pdsDocs.slice(0, 5).forEach(d => {
      const filename = d.url ? d.url.split('/').pop() : '(no url)';
      console.log(`  documents/Product-Data-Sheets/${filename}`);
    });

    console.log('\nActual R2 keys under "documents/" prefix (first 30):');
    try {
      const keys = await listR2Prefix('documents/', 30);
      if (keys.length === 0) {
        console.log('  (no keys returned — bucket access OK but no objects under "documents/")');
      } else {
        keys.forEach(k => console.log(`  ${k}`));
      }
    } catch (e) {
      console.log(`  ERROR listing: ${e.message}`);
    }

    console.log('\nActual R2 keys under "" (root, first 30):');
    try {
      const keys = await listR2Prefix('', 30);
      if (keys.length === 0) {
        console.log('  (empty)');
      } else {
        keys.forEach(k => console.log(`  ${k}`));
      }
    } catch (e) {
      console.log(`  ERROR listing root: ${e.message}`);
    }

    console.log('\nDone — no fetches attempted.');
    return;
  }

  // Load existing enriched data if resuming
  let enriched = {};
  if (RESUME && fs.existsSync(OUTPUT_FILE)) {
    enriched = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
    console.log(`▸ Resuming with ${Object.keys(enriched).length} previously-enriched products.`);
  }

  // Filter products
  let queue = products.filter(p => {
    if (!p.objectID || !p.name) return false;
    if (RESUME && enriched[p.objectID]) return false;
    if (FILTER_PRODUCT && !normalizeName(p.name).includes(normalizeName(FILTER_PRODUCT))) return false;
    return true;
  });

  if (LIMIT) queue = queue.slice(0, LIMIT);
  console.log(`▸ ${queue.length} products to enrich.`);

  let processed = 0;
  let failed = 0;
  let skippedNoPDS = 0;
  const startTime = Date.now();

  // Worker pool — parallelism for the slow Claude+PDF parsing step
  const workQueue = [...queue];
  async function worker() {
    while (workQueue.length > 0) {
      const product = workQueue.shift();
      if (!product) break;

      const pds = findPdsForProduct(product, pdsDocs);
      if (!pds || !pds.url) {
        skippedNoPDS++;
        continue;
      }

      const filename = pds.url.split('/').pop();

      try {
        const pdfBuf = await fetchUrlBuffer(pds.url);
        const parsed = await pdfParse(pdfBuf);
        const result = await extractPropertiesFromPDS(product.name, parsed.text);

        enriched[product.objectID] = {
          product_name: product.name,
          pds_filename: filename,
          pds_url: pds.url,
          properties: result.properties || [],
          extracted_at: new Date().toISOString(),
        };
        processed++;

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        console.log(`  [${processed}/${queue.length}] ✓ ${product.name} (${result.properties?.length || 0} props, ${elapsed}s)`);

        // Save progress
        if (processed % SAVE_EVERY === 0) {
          fs.writeFileSync(OUTPUT_FILE, JSON.stringify(enriched, null, 2));
          console.log(`  ↪ saved progress to ${OUTPUT_FILE}`);
        }
      } catch (err) {
        failed++;
        console.error(`  [×] ${product.name}: ${err.message}`);
      }
    }
  }

  // Launch parallel workers
  const workers = Array.from({ length: PARALLELISM }, () => worker());
  await Promise.all(workers);

  // Final save
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(enriched, null, 2));
  console.log(`\n✓ Saved final to ${OUTPUT_FILE}`);

  // Optional R2 upload
  if (UPLOAD) {
    console.log('▸ Uploading to R2 metadata/properties.json...');
    await uploadR2Json('metadata/properties.json', enriched);
    console.log('✓ Uploaded.');
  }

  // Stats
  const elapsedMin = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log('\n--- summary ---');
  console.log(`Processed:      ${processed}`);
  console.log(`No PDS match:   ${skippedNoPDS}`);
  console.log(`Failed:         ${failed}`);
  console.log(`Total enriched: ${Object.keys(enriched).length}`);
  console.log(`Elapsed:        ${elapsedMin} min`);
  console.log('\nNext steps:');
  console.log('  1. Restart Skyfall to pick up the new properties.json');
  console.log('  2. Run a real spec through the analyze flow');
  console.log('  3. Verify the Property Comparison shows real Soprema values');
  if (!UPLOAD) {
    console.log('  4. (Optional) Re-run with --upload to push properties.json to R2');
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
