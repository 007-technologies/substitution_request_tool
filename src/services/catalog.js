const { fetchMetadata } = require('./r2');

let products = null;
let documents = null;
let enrichedProperties = null;       // keyed by objectID, populated by scripts/enrich-catalog.js
let condensedCatalog = null;
let documentsListStr = null;
let lastFilteredProducts = null;     // populated by getFilteredCatalog so getDocumentsList can scope

async function loadCatalog() {
  if (products && documents) return;
  const [rawProducts, rawDocuments] = await Promise.all([
    fetchMetadata('metadata/products.json'),
    fetchMetadata('metadata/documents.json'),
  ]);
  products = rawProducts;
  documents = rawDocuments;

  // Optional enrichment data — produced by scripts/enrich-catalog.js.
  // If it doesn't exist in R2 yet, gracefully degrade (matcher will show
  // "not in catalog" for properties without enriched data, which is the
  // current Tier 1 behavior).
  try {
    enrichedProperties = await fetchMetadata('metadata/properties.json');
    const count = Object.keys(enrichedProperties || {}).length;
    console.log('[catalog] Loaded enriched properties for ' + count + ' products.');
  } catch (e) {
    enrichedProperties = null;
    console.log('[catalog] No enriched properties.json in R2 — running with raw catalog only.');
  }

  condensedCatalog = buildCondensedCatalog(products);
  documentsListStr = buildDocumentsList(documents);
}

// Per-product properties cap. PDS extractions averaged 50–80 properties,
// many of which are lab-test conditions architects don't read. After the
// dedupe-by-name pass with imperial preference, 25 covers the full range
// of comparison properties even on heavy products like SOPRA-ISO (which
// has 40 unique property keys including grade variants and metric pairs).
// 15 was too tight — SOPRA-ISO's thickness_minimum/maximum kept getting
// pushed past the cap, breaking the range-aggregation rule for thickness.
const MAX_PROPERTIES_PER_PRODUCT = 25;
// Hard cap on number of candidate products sent to the matcher in one
// request — keeps the prompt under Sonnet's 200K token input limit.
const MAX_FILTERED_PRODUCTS = 100;
// Top-N candidates guaranteed per spec product type, so a spec that mixes
// insulation + primer + fastener + adhesive doesn't drop the fastener/
// adhesive candidates in favor of more insulation products.
const TOP_PER_CATEGORY = 12;

function buildCondensedCatalog(productList, opts = {}) {
  const includeProperties = opts.includeProperties !== false;
  const includeTechnical  = opts.includeTechnical  !== false;

  const relevant = productList.map((p) => {
    const entry = { id: p.objectID, name: p.name };

    // Friendly aliases for known fields — keep these for backwards
    // compatibility with the matcher's existing logic.
    if (p.sopmkg0401) entry.application = p.sopmkg0401;
    if (p.sopinf0520) entry.role = Array.isArray(p.sopinf0520) ? p.sopinf0520.join(', ') : p.sopinf0520;
    if (p.soptec0471) entry.astm = p.soptec0471;
    if (p.soptec0472) entry.type = p.soptec0472;
    if (p.soptec0473) entry.grade = p.soptec0473;
    if (p.euinf0040) entry.material = p.euinf0040;
    if (p.euinf0070) entry.top_surface = p.euinf0070;
    if (p.euinf0090) entry.bottom_surface = p.euinf0090;
    if (p.categories_without_path) entry.categories = p.categories_without_path;
    if (p._collections) entry.collections = p._collections;
    if (p.attribute_set_name) entry.family = p.attribute_set_name;

    // Enriched performance properties from scripts/enrich-catalog.js.
    // This is the data layer the matcher actually wants — structured
    // numerical performance properties extracted from the product's PDS.
    let hasEnrichedProperties = false;
    if (includeProperties && enrichedProperties && enrichedProperties[p.objectID]) {
      const enriched = enrichedProperties[p.objectID];
      if (Array.isArray(enriched.properties) && enriched.properties.length > 0) {
        // Dedupe by property name, preferring imperial units. Without this,
        // the cap fills up with thickness×2 + weight×2 + compressive×2 (each
        // duplicated as imperial + metric) and pushes the unique properties
        // (water_absorption, mold_resistance, etc.) past the cutoff.
        // DEXCELL FA was the canonical failure: water_absorption sat at
        // position 19 of 23 because positions 1–15 were imperial/metric pairs.
        const imperialUnits = new Set(['in', 'ft', 'lb/ft²', 'lb/ft2', 'lbf', 'lb/sf', 'lb/100sf', 'psi', 'lbf/in', '%', 'F', 'pcf', 'lb/cf', 'lb/gal', 'mil', 'perm', 'year', 'years']);
        const seen = new Map(); // property -> entry
        enriched.properties.forEach(prop => {
          const key = prop.property;
          const isImperial = imperialUnits.has(prop.unit);
          const existing = seen.get(key);
          if (!existing) {
            seen.set(key, prop);
          } else if (isImperial && !imperialUnits.has(existing.unit)) {
            // Replace metric duplicate with imperial version
            seen.set(key, prop);
          }
        });
        entry.properties = [...seen.values()].slice(0, MAX_PROPERTIES_PER_PRODUCT);
        hasEnrichedProperties = true;
      }
    }

    // Raw technical fields are a fallback for when enriched properties
    // aren't available. If we already have structured properties from the
    // PDS, the raw technical codes (soptec0xxx) are redundant noise that
    // eats context — drop them.
    if (includeTechnical && !hasEnrichedProperties) {
      const technical = {};
      Object.keys(p).forEach((k) => {
        if (!/^(soptec|euinf|sopmkg|sopinf)\d+$/i.test(k)) return;
        if (['sopmkg0401', 'sopinf0520', 'soptec0471', 'soptec0472', 'soptec0473',
             'euinf0040', 'euinf0070', 'euinf0090'].includes(k)) return;
        const v = p[k];
        if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) return;
        technical[k] = Array.isArray(v) ? v.join(', ') : v;
      });
      if (Object.keys(technical).length > 0) entry.technical = technical;
    }

    return entry;
  });
  return JSON.stringify(relevant);
}

function getFilteredCatalog(productTypes) {
  if (!products || !productTypes || productTypes.length === 0) return condensedCatalog;

  const inputTerms = productTypes.map(t => t.toLowerCase().trim());
  const termExpansions = {
    'cap sheet':     ['cap sheet', 'capsheet', 'granule', 'mineral surface', 'field membrane', 'sopralene', 'elastophene'],
    'base sheet':    ['base sheet', 'base ply', 'perforated', 'venting', 'elastophene hr', 'colvent', 'colphene'],
    'insulation':    ['insulation', 'polyiso', 'polyisocyanurate', 'iso board', 'rigid insulation', 'tapered', 'sopra-iso', 'sopra-xps'],
    'vapor barrier': ['vapor barrier', 'vapour barrier', 'vapor retarder', 'sopraseal stick vp', 'sopravap', 'soprafix base'],
    'membrane':      ['membrane', 'sbs', 'app', 'tpo', 'epdm', 'pvc', 'modified bitumen', 'sopralene', 'elastophene', 'colphene', 'sentinel'],
    'adhesive':      ['adhesive', 'bonding adhesive', 'cold adhesive', 'mastic', 'duotack', 'colply', 'lastobond', 'polyurethane adhesive', 'two-part adhesive', 'foam adhesive', 'spray adhesive', 'sentinel s bonding', 'sentinel h2o', 'soprafix bonding'],
    'primer':        ['primer', 'asphalt primer', 'acrylic primer', 'antirock primer', 'elastocol', 'alsan rs 222', 'alsan rs 276', 'alsan rs metal', 'sopraseal vp primer', '410 quick-dry', '104 asphalt primer'],
    'flashing':      ['flashing', 'metal flashing', 'coping', 'soprafix', 'soprabase', 'sopralap', 'soprafix mbb', 'alsan rs 230 flash', 'soprafix flash'],
    'fastener':      ['fastener', 'screw', 'plate', 'stress plate', 'soprafix stress', 'soprafix mbb batten', 'soprema #12', 'soprema #14', 'soprema #15', 'tri-fixx'],
    'coverboard':    ['coverboard', 'cover board', 'gypsum', 'wood fiber', 'dexcell', 'soprarock', 'securock'],
    'walkway':       ['walkway', 'walk pad', 'protection mat', 'soprawalk'],
    'sealant':       ['sealant', 'caulk', 'soprasealant', 'soprasealant', 'sopraseal sealant', 'sopralap sp'],
    'coating':       ['coating', 'pmma', 'silicone coating', 'acrylic coating', 'elastomeric', 'alsan rs 230', 'alsan trafik', 'alsan coating', '901', '911', '921', '923', '924', 'soprawaway'],
    'mastic':        ['mastic', 'roof cement', 'flashing cement', 'plastic cement', '101', '501', '508', '509', '950', '951'],
    'asphalt':       ['asphalt', 'type iv', 'type iii', 'type ii', 'astm d 312', 'astm d312', 'hot asphalt'],
  };

  // Named anchor products — guaranteed inclusion in candidates whenever the
  // matching category appears in the spec. These are products the matcher
  // MUST see in order to make a correct substitution. Pure score-based
  // filtering misses some of these because their catalog entries don't use
  // category words in the name (e.g. DUOTACK 365 is "Accessories" with no
  // "adhesive" in the name; pure scoring buries it at rank 53).
  const namedAnchors = {
    'adhesive':  ['duotack® 365', 'duotack® spf hfo adhesive', 'colply ef adhesive', 'sentinel® s bonding adhesive'],
    'fastener':  ['soprema #12 dp fastener', 'soprema #14 hd fastener'],
    'primer':    ['104 asphalt primer', '410 quick-dry asphalt primer', 'antirock primer', 'alsan rs 222 primer'],
    'coverboard':['dexcell fa glass mat roof board', 'soprarock'],
    'insulation':['sopra-iso', 'sopra-iso v', 'sopra-xps'],
    'coating':   ['alsan rs 230 field', 'alsan rs 260 lo field'],
    'cap sheet': ['sopralene flam 180', 'elastophene fr gr'],
    'base sheet':['elastophene hr', 'elastophene stick'],
  };

  const expandedTerms = new Set(['sbs', 'membrane', 'insulation']);
  inputTerms.forEach(term => {
    expandedTerms.add(term);
    Object.entries(termExpansions).forEach(([key, synonyms]) => {
      if (term.includes(key) || key.includes(term)) synonyms.forEach(s => expandedTerms.add(s));
    });
  });

  // For EACH input product type, find the top N matching products. This
  // guarantees coverage — if the spec has fasteners + insulation + primer +
  // adhesive, each category contributes its own top candidates, instead of
  // the global top-N being dominated by one over-represented category.
  const productStrCache = new Map();
  const productString = (p) => {
    const cached = productStrCache.get(p.objectID);
    if (cached) return cached;
    const s = JSON.stringify(p).toLowerCase();
    productStrCache.set(p.objectID, s);
    return s;
  };

  // Weighted scoring fields: a hit in the product NAME is worth far more than
  // a hit anywhere in the JSON blob. This keeps membranes from scoring high
  // on "adhesive" just because they mention lap-adhesion in a technical field.
  // Without this, DUOTACK 365 (name match only) ranks #53 while membranes that
  // mention "adhesive" in passing dominate the adhesive category.
  const scoreProduct = (p, synonymsForTerm) => {
    const name = ((p.product_name || p.name || '') + ' ' + (p.application || '') + ' ' + (p.role || '') + ' ' + (p.type || '')).toLowerCase();
    const fullJson = productString(p);
    let nameHits = 0;
    let jsonHits = 0;
    synonymsForTerm.forEach(syn => {
      if (name.includes(syn)) nameHits++;
      else if (fullJson.includes(syn)) jsonHits++;
    });
    // Name hits weighted 10x. A single name hit beats unlimited JSON hits.
    return nameHits * 10 + jsonHits;
  };

  const candidateMap = new Map();   // objectID -> { product, score }
  inputTerms.forEach(term => {
    // Collect synonyms for THIS specific term (not the global expanded set)
    const synonymsForTerm = new Set([term]);
    Object.entries(termExpansions).forEach(([key, syns]) => {
      if (term.includes(key) || key.includes(term)) syns.forEach(s => synonymsForTerm.add(s));
    });

    // Score products against this term's synonyms specifically
    const matchesForTerm = [];
    products.forEach(p => {
      const s = scoreProduct(p, synonymsForTerm);
      if (s > 0) matchesForTerm.push({ product: p, score: s });
    });

    // Take top N per category, merge into the candidate set
    matchesForTerm
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_PER_CATEGORY)
      .forEach(({ product, score }) => {
        const existing = candidateMap.get(product.objectID);
        // Keep the highest score across all categories so cross-category hits get priority
        if (!existing || score > existing.score) {
          candidateMap.set(product.objectID, { product, score });
        }
      });

    // Force-include named anchor products for this category even if they
    // didn't score in the top N. These are products the matcher MUST see.
    Object.entries(namedAnchors).forEach(([category, anchors]) => {
      if (!term.includes(category) && !category.includes(term)) return;
      anchors.forEach(anchorName => {
        const anchorNorm = anchorName.toLowerCase().replace(/[®™]/g, '').replace(/\s+/g, ' ').trim();
        const found = products.find(p => {
          const rawName = (p.product_name || p.name || '').toLowerCase();
          if (!rawName.trim()) return false;  // skip empty-name catalog rows
          const productNorm = rawName.replace(/[®™]/g, '').replace(/\s+/g, ' ').trim();
          // Bidirectional substring match on normalized names; both sides must be non-empty
          return productNorm.includes(anchorNorm) || anchorNorm.includes(productNorm);
        });
        if (found && !candidateMap.has(found.objectID)) {
          // Score 100 = highest possible, ensures it survives the global cap
          candidateMap.set(found.objectID, { product: found, score: 100 });
        }
      });
    });
  });

  let filtered = [...candidateMap.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_FILTERED_PRODUCTS)
    .map(s => s.product);

  // If the filter produced almost nothing, fall back to a LITE full catalog
  // (categorical info only, no properties or technical fields). Keeps the
  // prompt under Sonnet's 200K token cap when we have to send the whole catalog.
  if (filtered.length < 20) {
    console.log('[catalog] Filter too aggressive — falling back to lite full catalog (no properties).');
    return buildCondensedCatalog(products, { includeProperties: false, includeTechnical: false });
  }

  console.log('[catalog] Filtered: ' + filtered.length + ' of ' + products.length + ' candidate products (capped at ' + MAX_FILTERED_PRODUCTS + ', sorted by relevance).');
  // Cache the filtered set so getDocumentsList() can scope to just these products
  lastFilteredProducts = filtered;
  return buildCondensedCatalog(filtered);
}

function buildDocumentsList(documents) {
  const usefulTypes = new Set([
    'Product Data Sheets', 'Safety Data Sheets', 'Installation Guides',
    'Technical Bulletins', 'Guide Specifications', 'Technical Guides',
  ]);
  const relevant = documents
    .filter((d) => d.url && usefulTypes.has(d.type))
    .map((d) => {
      const type = (d.type || 'uncategorized').replace(/[^a-zA-Z0-9\- ]/g, '').replace(/\s+/g, '-');
      const filename = d.url.split('/').pop();
      // url is the real source on Soprema's CDN (my.assets-library.com).
      // r2Key is kept for backwards compatibility but is not used to fetch
      // the actual file — the bundle handler uses url. The matcher only
      // sees the name/type/filename to decide which docs to attach.
      return { name: d.name || filename, type: d.type, r2Key: 'documents/' + type + '/' + filename, filename, url: d.url };
    });
  return JSON.stringify(relevant);
}

function getCondensedCatalog() { return condensedCatalog; }

// If a filtered set is cached, scope the documents list to docs whose name
// references one of those products. Drops the doc payload from ~755 docs
// (~38K tokens) to maybe 80–150 docs (~4–8K tokens).
//
// Uses TOKEN-BASED matching instead of substring. Catalog product names
// don't always appear as exact substrings in their doc filenames — for
// example, product "SOPREMA #12 DP FASTENER" has its PDS named "PDS -
// SOPRAFIX® FASTENER #12 DP" (different brand prefix, reordered tokens).
// Substring match returned zero results for the fastener and the matcher
// fell back to TRI-FIXX FASTENING SYSTEM (a different fastener line).
// Token overlap fixes this — if 2+ significant tokens from the product
// name appear in the doc name, we consider it a match.
function getDocumentsList() {
  if (!lastFilteredProducts || !documents) return documentsListStr;

  // Tokens with low signal value — common across many product/doc names.
  const stopTokens = new Set(['the', 'and', 'for', 'pds', 'sds', 'with', 'product', 'data', 'sheet', 'safety', 'soprema']);

  const tokenize = (s) => (s || '')
    .toLowerCase()
    .replace(/[®™©]/g, '')
    .replace(/[^a-z0-9#]+/g, ' ')
    .split(/\s+/)
    .filter(t => t && t.length >= 2 && !stopTokens.has(t));

  const productTokenSets = lastFilteredProducts
    .map(p => ({ name: p.name, tokens: new Set(tokenize(p.name)) }))
    .filter(p => p.tokens.size > 0);

  const usefulTypes = new Set([
    'Product Data Sheets', 'Safety Data Sheets', 'Installation Guides',
    'Technical Bulletins', 'Guide Specifications', 'Technical Guides',
  ]);

  const relevant = documents
    .filter((d) => d.url && usefulTypes.has(d.type))
    .filter((d) => {
      const docTokens = new Set(tokenize(d.name));
      if (docTokens.size === 0) return false;
      // Match if any product has 2+ significant tokens overlap with doc name.
      // For very short product names (1-2 tokens), require full overlap.
      return productTokenSets.some(p => {
        let hits = 0;
        p.tokens.forEach(t => { if (docTokens.has(t)) hits++; });
        const required = p.tokens.size <= 2 ? p.tokens.size : 2;
        return hits >= required;
      });
    })
    .map((d) => {
      const type = (d.type || 'uncategorized').replace(/[^a-zA-Z0-9\- ]/g, '').replace(/\s+/g, '-');
      const filename = d.url.split('/').pop();
      // url is the real source on Soprema's CDN (my.assets-library.com).
      // r2Key is kept for backwards compatibility but is not used to fetch
      // the actual file — the bundle handler uses url. The matcher only
      // sees the name/type/filename to decide which docs to attach.
      return { name: d.name || filename, type: d.type, r2Key: 'documents/' + type + '/' + filename, filename, url: d.url };
    });

  console.log('[catalog] Documents scoped to ' + relevant.length + ' (of ' + JSON.parse(documentsListStr).length + ' total).');
  return JSON.stringify(relevant);
}

// Look up a document's actual URL by its filename (e.g. "PDS-SOPRA-ISO.pdf").
// Used by the bundle export to resolve the real my.assets-library.com URL —
// the r2Key field on matched datasheets is a constructed path that doesn't
// exist as an R2 object. PDFs live on Soprema's external CDN, not R2.
function getDocumentUrlByFilename(filename) {
  if (!filename || !documents) return null;
  const target = String(filename).toLowerCase();
  const match = documents.find(d => {
    if (!d || !d.url) return false;
    const docFilename = (d.url.split('/').pop() || '').toLowerCase();
    return docFilename === target;
  });
  return match ? match.url : null;
}

module.exports = { loadCatalog, getCondensedCatalog, getDocumentsList, getFilteredCatalog, getDocumentUrlByFilename };
