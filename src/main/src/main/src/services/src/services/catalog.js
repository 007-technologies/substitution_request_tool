const { fetchMetadata } = require('./r2');

let products = null;
let documents = null;
let condensedCatalog = null;
let documentsListStr = null;

/**
 * Load products and documents from R2 (cached after first call).
 */
async function loadCatalog() {
  if (products && documents) return;

  const [rawProducts, rawDocuments] = await Promise.all([
    fetchMetadata('metadata/products.json'),
    fetchMetadata('metadata/documents.json'),
  ]);

  products = rawProducts;
  documents = rawDocuments;

  condensedCatalog = buildCondensedCatalog(products);
  documentsListStr = buildDocumentsList(documents);
}

/**
 * Aggressively condense products - only fields Claude needs for matching.
 */
function buildCondensedCatalog(products) {
  const relevant = products.map((p) => {
    const entry = { id: p.objectID, name: p.name };
    // Application method
    if (p.sopmkg0401) entry.application = p.sopmkg0401;
    // Product role (e.g., "Field Cap Sheet", "Base Sheet")
    if (p.sopinf0520) entry.role = Array.isArray(p.sopinf0520) ? p.sopinf0520.join(', ') : p.sopinf0520;
    // ASTM standard
    if (p.soptec0471) entry.astm = p.soptec0471;
    // Type and Grade
    if (p.soptec0472) entry.type = p.soptec0472;
    if (p.soptec0473) entry.grade = p.soptec0473;
    // Material technology
    if (p.euinf0040) entry.material = p.euinf0040;
    // Surface types
    if (p.euinf0070) entry.top_surface = p.euinf0070;
    if (p.euinf0090) entry.bottom_surface = p.euinf0090;
    // Categories (just the leaf categories, no path noise)
    if (p.categories_without_path) entry.categories = p.categories_without_path;
    // Collections (e.g., "2 Ply SBS Membrane")
    if (p._collections) entry.collections = p._collections;
    // Attribute set (e.g., "Waterproofing")
    if (p.attribute_set_name) entry.family = p.attribute_set_name;
    return entry;
  });

  return JSON.stringify(relevant);
}

/**
 * Only keep documents useful for substitution requests:
 * Product Data Sheets, Safety Data Sheets, Installation Guides, Technical Bulletins.
 * Strip everything except name, type, and r2Key.
 */
function buildDocumentsList(documents) {
  const usefulTypes = new Set([
    'Product Data Sheets',
    'Safety Data Sheets',
    'Installation Guides',
    'Technical Bulletins',
    'Guide Specifications',
    'Technical Guides',
  ]);

  const relevant = documents
    .filter((d) => d.url && usefulTypes.has(d.type))
    .map((d) => {
      const type = (d.type || 'uncategorized')
        .replace(/[^a-zA-Z0-9\- ]/g, '')
        .replace(/\s+/g, '-');
      const filename = d.url.split('/').pop();
      return {
        name: d.name || filename,
        type: d.type,
        r2Key: `documents/${type}/${filename}`,
        filename,
      };
    });

  return JSON.stringify(relevant);
}

function getCondensedCatalog() {
  return condensedCatalog;
}

function getDocumentsList() {
  return documentsListStr;
}

module.exports = { loadCatalog, getCondensedCatalog, getDocumentsList };
