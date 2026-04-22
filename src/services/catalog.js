const { fetchMetadata } = require('./r2');

let products = null;
let documents = null;
let condensedCatalog = null;
let documentsListStr = null;

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

function buildCondensedCatalog(productList) {
  const relevant = productList.map((p) => {
    const entry = { id: p.objectID, name: p.name };
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
    return entry;
  });
  return JSON.stringify(relevant);
}

function getFilteredCatalog(productTypes) {
  if (!products || !productTypes || productTypes.length === 0) return condensedCatalog;

  const inputTerms = productTypes.map(t => t.toLowerCase().trim());
  const termExpansions = {
    'cap sheet':     ['cap sheet', 'capsheet', 'granule', 'mineral surface', 'field membrane'],
    'base sheet':    ['base sheet', 'base ply', 'perforated', 'venting'],
    'insulation':    ['insulation', 'polyiso', 'polyisocyanurate', 'iso board', 'rigid insulation', 'tapered'],
    'vapor barrier': ['vapor barrier', 'vapour barrier', 'vapor retarder'],
    'membrane':      ['membrane', 'sbs', 'app', 'tpo', 'epdm', 'pvc', 'modified bitumen'],
    'adhesive':      ['adhesive', 'bonding adhesive', 'cold adhesive', 'mastic'],
    'primer':        ['primer', 'asphalt primer', 'acrylic primer'],
    'flashing':      ['flashing', 'metal flashing', 'coping'],
    'fastener':      ['fastener', 'screw', 'plate', 'stress plate'],
    'coverboard':    ['coverboard', 'cover board', 'gypsum', 'wood fiber'],
    'walkway':       ['walkway', 'walk pad', 'protection mat'],
    'sealant':       ['sealant', 'caulk'],
  };

  const expandedTerms = new Set(['sbs', 'membrane', 'insulation']);
  inputTerms.forEach(term => {
    expandedTerms.add(term);
    Object.entries(termExpansions).forEach(([key, synonyms]) => {
      if (term.includes(key) || key.includes(term)) synonyms.forEach(s => expandedTerms.add(s));
    });
  });

  const filtered = products.filter(p => {
    const productStr = JSON.stringify(p).toLowerCase();
    return [...expandedTerms].some(term => productStr.includes(term));
  });

  if (filtered.length < 20) {
    console.log('[catalog] Filter too aggressive, using full catalog.');
    return condensedCatalog;
  }

  console.log('[catalog] Filtered: ' + filtered.length + ' of ' + products.length + ' products sent to Claude.');
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
      return { name: d.name || filename, type: d.type, r2Key: 'documents/' + type + '/' + filename, filename };
    });
  return JSON.stringify(relevant);
}

function getCondensedCatalog() { return condensedCatalog; }
function getDocumentsList()    { return documentsListStr; }

module.exports = { loadCatalog, getCondensedCatalog, getDocumentsList, getFilteredCatalog };
