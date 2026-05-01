let selectedFilePath = null;

// Cipher's brand identity — drives the cover letter signature, page header,
// and the few customer-facing places "Soprema" appears in user-visible text.
// Defaults match the original Soprema-only build; per-customer config in
// config.json overrides via the BRAND_* fields. Refreshed at app start.
let cipherBrand = {
  name: 'Soprema',
  nameFull: 'Soprema USA',
  repTitle: 'Manufacturer Representative',
  productLabel: 'Soprema product',
};
(async function loadCipherBrand() {
  try {
    if (window.api && window.api.getAppInfo) {
      const info = await window.api.getAppInfo();
      if (info && info.success && info.brand) cipherBrand = info.brand;
    }
  } catch (_) { /* fall back to Soprema defaults */ }
})();

// Elements
const uploadSection = document.getElementById('upload-section');
const loadingSection = document.getElementById('loading-section');
const errorSection = document.getElementById('error-section');
const resultsSection = document.getElementById('results-section');
const dropZone = document.getElementById('drop-zone');
const selectBtn = document.getElementById('select-btn');
const analyzeBtn = document.getElementById('analyze-btn');
const fileName = document.getElementById('file-name');
const progressText = document.getElementById('progress-text');
const errorText = document.getElementById('error-text');
const retryBtn = document.getElementById('retry-btn');
const exportBtn = document.getElementById('export-btn');
const newBtn = document.getElementById('new-btn');

// Optional loading UI elements
const loadingBarFill = document.getElementById('loading-bar-fill');
const loadingPercent = document.getElementById('loading-percent');
const loadingSubtext = document.getElementById('loading-subtext');

// Loading state config
const loadingSteps = {
  uploading: {
    label: 'Reading specification...',
    percent: 8,
    subtext: 'Preparing your file for analysis.'
  },
  extracting: {
    label: 'Extracting relevant sections...',
    percent: 24,
    subtext: 'Scanning the spec for roofing-related content.'
  },
  matching: {
    label: 'Matching Soprema products...',
    percent: 52,
    subtext: 'Comparing specified products against the Soprema catalog.'
  },
  generating: {
    label: 'Finalizing results...',
    percent: 78,
    subtext: 'Building your report and preparing results.'
  },
  complete: {
    label: 'Analysis complete.',
    percent: 100,
    subtext: 'Your results are ready.'
  }
};

let currentLoadingState = 'uploading';
let progressAnimationInterval = null;
let displayedPercent = 0;

// ── Sidebar progress tracker ───────────────────────────────────────────────
// Four-step user journey (data-step = upload | analyze | review | export).
// Lights up the active step, marks prior steps completed, disables the rest.
const SIDEBAR_STEPS = ['upload', 'analyze', 'review', 'export'];

function setSidebarStep(activeStep) {
  const idx = SIDEBAR_STEPS.indexOf(activeStep);
  if (idx === -1) return;
  SIDEBAR_STEPS.forEach((step, i) => {
    const el = document.querySelector(`.sidebar-item[data-step="${step}"]`);
    if (!el) return;
    el.classList.remove('is-active', 'is-completed', 'is-disabled');
    if (i < idx) el.classList.add('is-completed');
    else if (i === idx) el.classList.add('is-active');
    else el.classList.add('is-disabled');
  });
}

// Every loading phase = the single "Analyze" step from the user's POV.
const LOADING_TO_SIDEBAR_STEP = {
  uploading: 'analyze',
  extracting: 'analyze',
  matching: 'analyze',
  generating: 'analyze',
  complete: 'review',
};

// All top-level sections. Any id here can be passed to showSection().
const ALL_SECTION_IDS = [
  'upload',
  'loading',
  'error',
  'results',
  'library-recent',
  'library-catalog',
  'library-drafts',
  'help-guide',
  'settings',
];

// State management
function showSection(id) {
  ALL_SECTION_IDS.forEach((secId) => {
    const el = document.getElementById(`${secId}-section`);
    if (el) el.classList.add('hidden');
  });
  const target = document.getElementById(`${id}-section`);
  if (target) target.classList.remove('hidden');

  // Keep sidebar Session-step indicator in sync
  if (id === 'upload') setSidebarStep('upload');
  else if (id === 'results') setSidebarStep('review');
  // library/settings/help/error leave the sidebar step as-is

  // Toggle active state on sidebar library/help/settings nav items
  document.querySelectorAll('.sidebar-nav').forEach((el) => {
    el.classList.toggle('is-nav-active', el.dataset.nav === SECTION_TO_NAV[id]);
  });

  // Scroll the content to top on any section change
  const content = document.querySelector('.app-content');
  if (content) content.scrollTop = 0;
}

// Map a section id to the sidebar nav key that should be highlighted.
const SECTION_TO_NAV = {
  'library-recent':  'recent',
  'library-catalog': 'catalog',
  'library-drafts':  'drafts',
  'help-guide':      'guide',
  'settings':        'settings',
};

// Inline loading — shows/hides the loading card within the upload section
// and swaps the section header so "01 Upload" becomes "02 Analyze" while
// the user is waiting.
function showInlineLoading(show) {
  const card          = document.getElementById('upload-loading-card');
  const zone          = document.getElementById('drop-zone');
  const btn           = document.getElementById('analyze-btn');
  const intakeHeader  = document.getElementById('upload-intro-header');
  const analyzeHeader = document.getElementById('analyze-header');
  const history       = document.getElementById('session-history-container');

  if (show) {
    uploadSection.classList.remove('hidden');
    zone.classList.add('hidden');
    btn.classList.add('hidden');
    card.classList.remove('hidden');
    intakeHeader?.classList.add('hidden');
    analyzeHeader?.classList.remove('hidden');
    history?.classList.add('hidden');
  } else {
    card.classList.add('hidden');
    zone.classList.remove('hidden');
    btn.classList.remove('hidden');
    intakeHeader?.classList.remove('hidden');
    analyzeHeader?.classList.add('hidden');
    history?.classList.remove('hidden');
  }
}

function setLoadingState(stateKey, overrideMessage = null) {
  const step = loadingSteps[stateKey];
  if (!step) return;

  currentLoadingState = stateKey;

  // Sync sidebar step indicator
  const sidebarStep = LOADING_TO_SIDEBAR_STEP[stateKey];
  if (sidebarStep) setSidebarStep(sidebarStep);

  if (progressText) {
    progressText.textContent = overrideMessage || step.label;
  }

  if (loadingSubtext) {
    loadingSubtext.textContent = step.subtext || '';
  }

  animateProgressTo(step.percent);
}

function animateProgressTo(targetPercent) {
  const safeTarget = Math.max(0, Math.min(100, targetPercent));

  if (progressAnimationInterval) {
    clearInterval(progressAnimationInterval);
  }

  progressAnimationInterval = setInterval(() => {
    if (displayedPercent >= safeTarget) {
      clearInterval(progressAnimationInterval);
      progressAnimationInterval = null;
      startMicroDrift(safeTarget);
      return;
    }
    displayedPercent += 1;
    updateProgressUI(displayedPercent);
  }, 55 + Math.random() * 30);
}

let microDriftInterval = null;

function startMicroDrift(fromPercent) {
  if (microDriftInterval) clearInterval(microDriftInterval);
  // Never drift past 2% below the next major step (capped at 95)
  const cap = Math.min(fromPercent + 8, 95);
  microDriftInterval = setInterval(() => {
    if (displayedPercent >= cap) {
      clearInterval(microDriftInterval);
      microDriftInterval = null;
      return;
    }
    // Random tiny tick: moves 0 or 1% every 800–1800ms to look organic
    if (Math.random() > 0.45) {
      displayedPercent = Math.min(displayedPercent + 1, cap);
      updateProgressUI(displayedPercent);
    }
  }, 900 + Math.random() * 600);
}

function updateProgressUI(percent) {
  const whole = Math.floor(percent);
  if (loadingBarFill) {
    loadingBarFill.style.width = `${whole}%`;
  }
  if (loadingPercent) {
    loadingPercent.textContent = `${whole}%`;
  }
}

function resetLoadingUI() {
  currentLoadingState = 'uploading';
  displayedPercent = 0;

  if (progressAnimationInterval) {
    clearInterval(progressAnimationInterval);
    progressAnimationInterval = null;
  }

  if (progressText) {
    progressText.textContent = 'Preparing analysis...';
  }

  if (loadingSubtext) {
    loadingSubtext.textContent = 'Getting everything ready.';
  }

  updateProgressUI(0);
}

// Map a free-form progress message (sent from main.js) to one of the
// pre-defined loading-step buckets so the loading bar advances visually
// alongside the text update. Order matters — earlier keywords win when
// a message could plausibly match multiple buckets (e.g. "matching against
// catalog" → matching, not extracting).
function inferLoadingStateFromMessage(message = '') {
  const lower = message.toLowerCase();

  if (
    lower.includes('upload') ||
    lower.includes('reading specification') ||
    lower.includes('reading file') ||
    lower.includes('preparing')
  ) {
    return 'uploading';
  }

  if (
    lower.includes('extract') ||
    lower.includes('scan') ||
    lower.includes('roofing text') ||
    lower.includes('roofing-related') ||
    lower.includes('analyzing') ||
    lower.includes('parsing') ||
    lower.includes('found') && lower.includes('page')
  ) {
    return 'extracting';
  }

  if (
    lower.includes('match') ||
    lower.includes('catalog') ||
    lower.includes('product') ||
    lower.includes('comparing')
  ) {
    return 'matching';
  }

  if (
    lower.includes('generat') ||
    lower.includes('final') ||
    lower.includes('report') ||
    lower.includes('substitution')
  ) {
    return 'generating';
  }

  if (lower.includes('complete')) return 'complete';

  return null;
}

// File selection via native dialog
selectBtn.addEventListener('click', async () => {
  const path = await window.api.selectFile();
  if (path) setFile(path);
});

// Prevent Electron from navigating away when a file is dropped
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

let dragCounter = 0;

dropZone.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dragCounter--;
  if (dragCounter === 0) dropZone.classList.remove('dragover');
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file && file.name.toLowerCase().endsWith('.pdf')) {
    const filePath = window.api.getFilePath(file);
    if (filePath) setFile(filePath);
  }
});

function setFile(path) {
  selectedFilePath = path;
  const name = path.split(/[/\\]/).pop();
  fileName.textContent = name;
  analyzeBtn.disabled = false;
}

// Sample-spec discovery: ask the main process if assets/samples/sample-spec.pdf
// is bundled with this build. If yes, surface the "Try with a sample spec"
// button beneath the dropzone — that's the only path this UI shows up.
// If no sample is bundled, the hint stays hidden and there's no broken affordance.
(async function setupSampleSpecAffordance() {
  try {
    if (!window.api || !window.api.getSampleSpec) return;
    const result = await window.api.getSampleSpec();
    if (!result || !result.available) return;
    const hint = document.getElementById('sample-spec-hint');
    const btn = document.getElementById('load-sample-spec');
    if (!hint || !btn) return;
    hint.classList.remove('hidden');
    btn.addEventListener('click', () => {
      // Reuse the existing setFile + analyze flow — the sample is just a normal
      // file path from the renderer's perspective, no special handling needed.
      setFile(result.path);
      // Telemetry: track who's actually using the bundled sample. Helps Reed
      // see funnel conversion (prospect-installed → sample-spec-loaded →
      // subrequest-generated). Source = 'upload-screen' here; the onboarding
      // modal's sample link uses source = 'onboarding-modal' to disambiguate.
      if (window.api && window.api.trackEvent) {
        window.api.trackEvent('sample_spec_loaded', { source: 'upload-screen' }).catch(() => {});
      }
      // Auto-trigger Analyze so the user goes straight from "show me how this
      // works" to seeing the result. They don't need to click a second button.
      if (analyzeBtn && !analyzeBtn.disabled) analyzeBtn.click();
    });
  } catch (_) { /* fail silently — never block first-launch UX on this */ }
})();

// Analyze
analyzeBtn.addEventListener('click', async () => {
  if (!selectedFilePath) return;

  // Reset ephemeral per-analysis state (draft id + query thread)
  if (typeof resetAnalysisEphemeralState === 'function') resetAnalysisEphemeralState();

  resetLoadingUI();
  showInlineLoading(true);
  setLoadingState('uploading');

  const result = await window.api.analyze(selectedFilePath);

  showInlineLoading(false);

  if (result.success) {
    setLoadingState('complete');
    saveCurrentSession(result.data);
    renderResults(result.data);
    showSection('results');
    showStep3(result.data.matched);
  } else {
    errorText.textContent = result.error || 'An unknown error occurred.';
    showSection('error');
  }
});

// Progress updates from main process
window.api.onProgress((message) => {
  const inferredState = inferLoadingStateFromMessage(message);
  if (inferredState) {
    setLoadingState(inferredState, message);
  } else if (progressText) {
    progressText.textContent = message;
  }
});

// Retry
retryBtn.addEventListener('click', () => {
  resetLoadingUI();
  showSection('upload');
});

// New analysis
newBtn.addEventListener('click', () => {
  selectedFilePath = null;
  fileName.textContent = '';
  analyzeBtn.disabled = true;

  const step3 = document.getElementById('step3');
  if (step3) step3.style.display = 'none';

  const preview = document.getElementById('subRequestPreview');
  if (preview) preview.style.display = 'none';

  currentMatchedData = null;
  lastExtracted = null;
  if (typeof resetAnalysisEphemeralState === 'function') resetAnalysisEphemeralState();
  resetLoadingUI();
  showSection('upload');
});

// Export PDF
exportBtn.addEventListener('click', async () => {
  const result = await window.api.exportPDF();
  if (result.success) {
    exportBtn.textContent = 'Exported!';
    setTimeout(() => { exportBtn.textContent = 'Export as PDF'; }, 2000);
  }
});

// Citation modal trigger
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.citation-more-btn');
  if (!btn) return;

  const encodedCitations = btn.getAttribute('data-citations');
  openCitationModalFromEncoded(encodedCitations);
});

// Render results
function renderResults(data) {
  const { extracted, matched } = data;
  lastExtracted = extracted;

  // Project info
  const projectInfo = document.getElementById('project-info');
  projectInfo.innerHTML = `
    <h2>${escape(extracted.project_name || 'Project Analysis')}</h2>
    <p>${escape(extracted.project_location || '')}${extracted.project_type ? ' &mdash; ' + escape(extracted.project_type) : ''}</p>
    ${extracted.roofing_system_type ? `<p>System: ${escape(extracted.roofing_system_type)}</p>` : ''}
  `;

  // System recommendation
  const sysRec = document.getElementById('system-recommendation');
  if (matched.system_recommendation) {
    sysRec.innerHTML = `<h3>System Recommendation</h3><p>${escape(matched.system_recommendation)}</p>`;
    sysRec.classList.remove('hidden');
  } else {
    sysRec.classList.add('hidden');
  }

  // Matches
  const matchesDiv = document.getElementById('matches-table');
  matchesDiv.innerHTML = '';

  // Confidence summary banner — gives Davis an immediate read on whether
  // anything needs attention before he reviews each row. Same green/yellow/red
  // dots SpecParse uses, with counts and a "Show flagged only" toggle that
  // jumps focus to the medium+low matches when there are many cards to wade
  // through. Hidden when there are no matches at all.
  if (matched.matches && matched.matches.length > 0) {
    const counts = { high: 0, medium: 0, low: 0, manual: 0 };
    matched.matches.forEach((m) => {
      const c = ((m.soprema_match || {}).confidence || 'medium').toLowerCase();
      counts[c] = (counts[c] || 0) + 1;
    });
    const flagged = (counts.medium || 0) + (counts.low || 0);
    const summary = document.createElement('div');
    summary.className = 'match-summary-bar';
    summary.innerHTML = `
      <div class="match-summary-counts">
        <span class="match-summary-total">${matched.matches.length} matches</span>
        <span class="match-summary-divider">·</span>
        <span class="conf-pill conf-pill-high"
              title="Verified — exact name + chemistry + application match"><span class="conf-dot conf-high"></span>${counts.high || 0} high</span>
        <span class="conf-pill conf-pill-medium"
              title="Clean AI match — worth a glance before sending"><span class="conf-dot conf-medium"></span>${counts.medium || 0} medium</span>
        <span class="conf-pill conf-pill-low"
              title="Uncertain match — review carefully before sending"><span class="conf-dot conf-low"></span>${counts.low || 0} low</span>
      </div>
      <button class="btn btn-ghost btn-sm" id="match-filter-flagged" style="${flagged > 0 ? '' : 'display:none'}">Show flagged only</button>
    `;
    matchesDiv.appendChild(summary);
  }

  if (matched.matches && matched.matches.length > 0) {
    matched.matches.forEach((m, matchIndex) => {
      const spec = m.spec_product || {};
      const sop = m.soprema_match || {};
      const conf = (sop.confidence || 'medium').toLowerCase();

      let datasheetHTML = '';
      if (m.datasheets && m.datasheets.length > 0) {
        datasheetHTML = `
          <div class="datasheet-links">
            ${m.datasheets.map(d => `
              <a class="datasheet-link" onclick="downloadDatasheet('${escapeAttr(d.r2Key)}', '${escapeAttr(d.filename || d.name)}')" title="${escape(d.type || 'Document')}">
                ${escape(d.name || d.filename || 'Datasheet')}
              </a>
            `).join('')}
          </div>
        `;
      }

      // Citation matching against extracted products
      const extractedProducts = extracted.products || [];
      let citationSource = null;

      const specProductName = (spec.product_name || '').trim().toLowerCase();
      const specManufacturer = (spec.manufacturer || '').trim().toLowerCase();
      const specProductType = (spec.product_type || '').trim().toLowerCase();

      citationSource =
        extractedProducts.find((p) =>
          (p.product_name || '').trim().toLowerCase() === specProductName &&
          specProductName
        ) ||
        extractedProducts.find((p) =>
          (p.manufacturer || '').trim().toLowerCase() === specManufacturer &&
          (p.product_type || '').trim().toLowerCase() === specProductType &&
          specManufacturer
        ) ||
        extractedProducts.find((p) =>
          (p.product_type || '').trim().toLowerCase() === specProductType &&
          specProductType &&
          Array.isArray(p.citations) &&
          p.citations.length > 0
        );

      const citationsHTML = renderCitations(citationSource?.citations || []);

      // Tooltip text for the confidence pill — explains *why* this row got
      // its color so Davis isn't guessing what "medium" means in practice.
      const confTooltip = {
        high:   'High confidence — exact match on chemistry, application, and role.',
        medium: 'Medium confidence — clean match but the chemistry or application differs slightly. Worth a glance.',
        low:    'Low confidence — alternative technology or generic fallback. Please review carefully before sending.',
        manual: 'Manually overridden by you.',
      }[conf] || 'AI-suggested match.';

      const card = document.createElement('div');
      card.className = 'match-card';
      card.dataset.confidence = conf;
      card.innerHTML = `
        <div class="match-side">
          <h4>Specified Product</h4>
          <div class="manufacturer">${escape(spec.manufacturer || 'Unspecified')}</div>
          <div class="product-name">${escape(spec.product_name || 'Unknown Product')}</div>
          <span class="product-type">${escape(spec.product_type || 'material')}</span>
          ${spec.specifications ? `<div class="specs">${escape(spec.specifications)}</div>` : ''}
          ${spec.section ? `<div class="specs">Section: ${escape(spec.section)}</div>` : ''}
          ${citationsHTML}
        </div>
        <div class="match-arrow">&rarr;</div>
        <div class="match-side">
          <div class="match-side-header">
            <h4>Soprema Replacement</h4>
            <button class="override-btn" onclick="openOverrideModal(${matchIndex})">Change</button>
          </div>
          <div class="manufacturer">SOPREMA</div>
          <div class="product-name">${escape(sop.product_name || 'No match found')}</div>
          <span class="product-type">${escape(sop.product_type || 'material')}</span>
          <span class="confidence confidence-${conf}" title="${escape(confTooltip)}"><span class="conf-dot conf-${conf}"></span>${conf}</span>
          ${sop.key_specs ? `<div class="specs">${escape(sop.key_specs)}</div>` : ''}
        </div>
        <div class="match-details">
          <p><strong>Rationale:</strong> ${escape(m.rationale || '')}</p>
          ${m.spec_differences && m.spec_differences !== 'None' ? `<p><strong>Differences:</strong> ${escape(m.spec_differences)}</p>` : ''}
          ${datasheetHTML}
        </div>
      `;
      matchesDiv.appendChild(card);
    });
  } else {
    matchesDiv.innerHTML = `
      <div class="empty-state">
        <h3>No roofing products identified</h3>
        <p>This spec doesn't appear to contain roofing products Soprema can substitute, or the products could not be read from this document.</p>
        <p>Try checking that this is a roofing spec (CSI Division 07) and that the PDF contains selectable text rather than scanned images.</p>
      </div>`;
  }

  // Submission notes
  const notes = document.getElementById('submission-notes');
  if (matched.submission_notes) {
    notes.innerHTML = `<h3>Submission Notes</h3><p>${escape(matched.submission_notes)}</p>`;
    notes.classList.remove('hidden');
  } else {
    notes.classList.add('hidden');
  }

  // Wire the "Show flagged only" toggle. Filter is applied via a body class
  // so we don't have to teach every other render path about it — the CSS rule
  // hides .match-card[data-confidence="high"] when body.match-flagged-only is set.
  const filterBtn = document.getElementById('match-filter-flagged');
  if (filterBtn) {
    filterBtn.addEventListener('click', () => {
      document.body.classList.toggle('match-flagged-only');
      const on = document.body.classList.contains('match-flagged-only');
      filterBtn.textContent = on ? 'Show all' : 'Show flagged only';
      filterBtn.classList.toggle('btn-active', on);
    });
  }
}

// Download datasheet
async function downloadDatasheet(r2Key, filename) {
  const result = await window.api.downloadDatasheet(r2Key, filename);
  if (result.error) {
    alert('Failed to download: ' + result.error);
  }
}

// Auto-update UI
window.api.onUpdateStatus(({ status, data }) => {
  const banner = document.getElementById('update-banner');
  const text = document.getElementById('update-text');
  const btn = document.getElementById('update-btn');

  switch (status) {
    case 'available':
      banner.classList.remove('hidden');
      text.textContent = `Update v${data} available. Downloading...`;
      break;
    case 'downloading':
      banner.classList.remove('hidden');
      text.textContent = `Downloading update... ${data}%`;
      break;
    case 'downloaded':
      banner.classList.remove('hidden');
      text.textContent = `Update v${data} ready.`;
      btn.classList.remove('hidden');
      btn.addEventListener('click', () => window.api.installUpdate());
      break;
    case 'error':
      break;
  }
});

// Utility: escape HTML
function escape(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

// Utility: escape for HTML attributes
function escapeAttr(str) {
  if (!str) return '';
  return String(str).replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// Utility: render citations
function renderCitations(citations = []) {
  if (!citations.length) return '';

  const maxCitations = 2;
  const visible = citations.slice(0, maxCitations);
  const remaining = citations.length - maxCitations;
  const encodedCitations = encodeURIComponent(JSON.stringify(citations));

  return `
    <div class="citations">
      <div class="citation-title">
        Source Reference${citations.length > 1 ? ` (${citations.length})` : ''}
      </div>

      ${visible.map((c) => `
        <div class="citation-card">
          <div class="citation-meta">
            Page ${escapeHtml(c.pageNumber || '?')}
            ${c.sectionTitle ? ` • ${escapeHtml(c.sectionTitle)}` : ''}
          </div>
          <div class="citation-quote">
            "${escapeHtml(c.quote || '')}"
          </div>
        </div>
      `).join('')}

      ${remaining > 0 ? `
        <button
          type="button"
          class="citation-meta citation-more-btn"
          data-citations="${encodedCitations}">
          +${remaining} more reference${remaining > 1 ? 's' : ''}
        </button>
      ` : ''}
    </div>
  `;
}

function openCitationModalFromEncoded(encodedCitations) {
  let citations = [];

  try {
    citations = JSON.parse(decodeURIComponent(encodedCitations || ''));
  } catch (err) {
    console.error('Failed to parse citations for modal:', err);
    return;
  }

  const existing = document.querySelector('.citation-modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'citation-modal-overlay';

  overlay.innerHTML = `
    <div class="citation-modal">
      <div class="citation-modal-header">
        <h3 class="citation-modal-title">All References (${citations.length})</h3>
        <button type="button" class="citation-modal-close" aria-label="Close citations modal">&times;</button>
      </div>
      <div class="citation-modal-body">
        ${citations.map((c) => `
          <div class="citation-card">
            <div class="citation-meta">
              Page ${escapeHtml(c.pageNumber || '?')}
              ${c.sectionTitle ? ` • ${escapeHtml(c.sectionTitle)}` : ''}
            </div>
            <div class="citation-quote">
              "${escapeHtml(c.quote || '')}"
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  overlay.addEventListener('click', (e) => {
    if (
      e.target === overlay ||
      e.target.classList.contains('citation-modal-close')
    ) {
      overlay.remove();
    }
  });

  document.body.appendChild(overlay);
}

// ══════════════════════════════════════════════════════════════════════════════
// STEP 3 — Substitution Request Generator
// ══════════════════════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────────────────────
let currentMatchedData = null;
let lastExtracted       = null;

// ── Show Step 3 panel after Step 2 finishes ───────────────────────────────────
function showStep3(matchedData) {
  currentMatchedData = matchedData;

  const dateField = document.getElementById('subRequestDate');
  if (dateField) {
    dateField.value = new Date().toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric'
    });
  }

  // Clear all Step 3 fields on every new analysis
  ['projectName', 'specSection', 'addressedTo', 'submittedBy', 'architectEmail'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  const step3 = document.getElementById('step3');
  if (step3) {
    step3.style.display = 'block';
  }
}

// ── Generate button ────────────────────────────────────────────────────────────
document.getElementById('generateSubRequestBtn')?.addEventListener('click', async () => {
  const projectName  = document.getElementById('projectName')?.value?.trim();
  const specSection  = document.getElementById('specSection')?.value?.trim();
  const addressedTo  = document.getElementById('addressedTo')?.value?.trim();
  const submittedBy  = document.getElementById('submittedBy')?.value?.trim();
  const date         = document.getElementById('subRequestDate')?.value?.trim();

  if (!projectName || !specSection || !addressedTo || !submittedBy) {
    alert('Please fill in all required fields (marked with *).');
    return;
  }

  if (!currentMatchedData) {
    alert('No analysis data found. Please complete Steps 1 & 2 first.');
    return;
  }

  const projectInfo = { projectName, specSection, addressedTo, submittedBy, date };

  // Persist form fields for next session
  ['projectName', 'specSection', 'addressedTo', 'submittedBy'].forEach(id => {
    const val = document.getElementById(id)?.value?.trim();
    if (val) localStorage.setItem('soprema_' + id, val);
  });

  const statusEl = document.getElementById('step3Status');
  statusEl.textContent = 'Generating substitution request…';
  statusEl.style.display = 'block';

  const btn = document.getElementById('generateSubRequestBtn');
  btn.disabled = true;
  btn.textContent = 'Generating…';

  try {
    const result = await window.api.generateSubRequest(currentMatchedData, projectInfo);

    if (!result.success) throw new Error(result.error || 'Unknown error');

    statusEl.style.display = 'none';
    renderSubstitutionRequest(result.data);

  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate Substitution Request';
  }
});

// Holds the most recently generated substitution-request payload so
// "Save draft" can persist both the form input + the generated request.
let lastSubRequestData = null;

// ── Render the generated form as styled HTML ───────────────────────────────────
function renderSubstitutionRequest(data) {
  const container = document.getElementById('subRequestContent');
  if (!container) return;

  lastSubRequestData = data;
  container.innerHTML = buildSubRequestHTML(data);

  const preview = document.getElementById('subRequestPreview');
  if (preview) {
    preview.style.display = 'block';
    preview.scrollIntoView({ behavior: 'smooth' });
  }

  // Inject a "Save draft" button into the preview toolbar (once, the
  // first time a sub request is generated in this session).
  if (!document.getElementById('saveDraftBtn')) {
    const exportBtn = document.getElementById('exportSubRequestBtn');
    if (exportBtn) {
      const btn = document.createElement('button');
      btn.id = 'saveDraftBtn';
      btn.type = 'button';
      btn.className = 'btn btn-ghost';
      btn.textContent = 'Save draft';
      exportBtn.insertAdjacentElement('beforebegin', btn);
    }
  }

  // Sub request generated — advance sidebar to the export step
  setSidebarStep('export');
}

// ── Export button ──────────────────────────────────────────────────────────────
document.getElementById('exportSubRequestBtn')?.addEventListener('click', async () => {
  const content = document.getElementById('subRequestContent');
  if (!content) return;

  const projectName = document.getElementById('projectName')?.value?.trim() || 'project';
  const specSection = document.getElementById('specSection')?.value?.trim() || 'section';
  const filename = `Substitution-Request-${specSection.replace(/[^a-z0-9]/gi, '-')}-${projectName.replace(/[^a-z0-9]/gi, '-')}.pdf`;

  const fullHTML = buildPrintableHTML(content.innerHTML);

  const result = await window.api.exportSubRequestPDF(fullHTML, filename);
  if (result.success) {
    alert(`Saved to: ${result.filePath}`);
  } else if (result.error) {
    alert(`Export failed: ${result.error}`);
  }
});

// ── Bundle export button ──────────────────────────────────────────────────────
// "Download Full Submission Package" — generates one PDF containing the cover
// letter + substitution request + every Soprema datasheet referenced by the
// matched products. Replaces ~hour of manual PDF assembly with one click.
document.getElementById('exportBundleBtn')?.addEventListener('click', async () => {
  const content = document.getElementById('subRequestContent');
  if (!content) {
    alert('No substitution request to bundle. Generate one first.');
    return;
  }
  if (!currentMatchedData) {
    alert('No matched product data — please complete Steps 1 & 2 first.');
    return;
  }

  const projectName  = document.getElementById('projectName')?.value?.trim() || 'project';
  const specSection  = document.getElementById('specSection')?.value?.trim() || 'section';
  const addressedTo  = document.getElementById('addressedTo')?.value?.trim() || '';
  const submittedBy  = document.getElementById('submittedBy')?.value?.trim() || '';
  const date         = document.getElementById('subRequestDate')?.value?.trim() || '';

  const projectInfo = { projectName, specSection, addressedTo, submittedBy, date };

  // Collect every unique r2Key from matched products' datasheets. The matcher
  // attaches these per-product; dedupe across the substitution set so the
  // same PDS isn't merged twice when two products share a system datasheet.
  const datasheets = [];
  const seen = new Set();
  (currentMatchedData.matches || []).forEach((m) => {
    (m.datasheets || []).forEach((d) => {
      if (d && d.r2Key && !seen.has(d.r2Key)) {
        seen.add(d.r2Key);
        datasheets.push({ r2Key: d.r2Key, filename: d.filename || d.name || 'datasheet.pdf' });
      }
    });
  });

  const filename =
    'Submission-Package-' +
    specSection.replace(/[^a-z0-9]/gi, '-') +
    '-' +
    projectName.replace(/[^a-z0-9]/gi, '-') +
    '.pdf';

  const coverLetterHTML = buildCoverLetterHTML(projectInfo, currentMatchedData, lastSubRequestData);
  const subRequestHTML = buildPrintableHTML(content.innerHTML);

  const btn = document.getElementById('exportBundleBtn');
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = `Building bundle (${datasheets.length} datasheets)…`;

  try {
    const result = await window.api.exportBundlePDF({
      coverLetterHTML,
      subRequestHTML,
      datasheets,
      filename,
    });

    if (!result.success) {
      alert('Bundle export failed: ' + (result.error || 'unknown error'));
      return;
    }

    let msg = 'Saved to: ' + result.filePath +
      '\n\n' + result.pageCount + ' pages total — cover letter + substitution request + ' +
      result.datasheetCount + ' Soprema datasheet' + (result.datasheetCount === 1 ? '' : 's') + '.';

    if (result.fetchFailures && result.fetchFailures.length) {
      msg += '\n\nNote: ' + result.fetchFailures.length + ' datasheet(s) could not be fetched and were not included:\n  • ' + result.fetchFailures.join('\n  • ');
    }
    if (result.mergeFailures && result.mergeFailures.length) {
      msg += '\n\nNote: ' + result.mergeFailures.length + ' document(s) failed to merge:\n  • ' + result.mergeFailures.join('\n  • ');
    }

    alert(msg);
  } catch (err) {
    alert('Bundle export error: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
});

// ── HTML builder — generates the printable form ───────────────────────────────
// New format: property-by-property comparison table with units, standards,
// citations, and honest "data missing" markers when the catalog doesn't have
// a value. Falls back to legacy comparisonPoints if a substitution was
// generated under the old prompts (e.g. resumed from an old draft).
// Deterministic compliance for general-knowledge range values. The matcher
// (Sonnet) consistently misjudges these — it gets "entire range fails" and
// "entire range passes" right but flips a coin on the straddle case despite
// the explicit Case A-E decision tree in match.txt. We override here using
// the same rule, in JS, where the result is reproducible.
//
// Returns: true | false | null (compliant) | undefined (cannot compute — leave matcher's value alone)
//
// rowProperty + specProductFallback give us a way to recover the comparator
// when the matcher dropped it from spec_required (e.g. wrote "3.2" instead
// of "3.2 min"). We look up the original property in spec_product's
// performance_properties[].comparator field and infer min/max from ">=" vs "<=".
function computeRangeComplianceForGK(specRequired, sopremaProvides, rowProperty, specProductFallback) {
  if (specRequired == null || sopremaProvides == null) return undefined;

  // Parse spec — expect "X min" or "X max" (with optional unit text).
  const specStr = String(specRequired).trim().toLowerCase();
  let specComparator;
  let specValue;
  const minMatch = specStr.match(/([\d.]+)\s*min\b/);
  const maxMatch = specStr.match(/([\d.]+)\s*max\b/);
  if (minMatch) {
    specComparator = 'min';
    specValue = parseFloat(minMatch[1]);
  } else if (maxMatch) {
    specComparator = 'max';
    specValue = parseFloat(maxMatch[1]);
  } else {
    // Comparator dropped from spec_required string. Recover via spec_product
    // lookup. Match by property name first (exact), then partial (substring
    // either direction — handles cases where the matcher renamed
    // "compressive_strength" to "compressive_strength_at_6_percent_deflection"),
    // then by numeric required_value match as a last resort.
    const bareMatch = specStr.match(/^([\d.]+)/);
    if (!bareMatch || !specProductFallback) return undefined;
    const props = specProductFallback.performance_properties || [];
    if (!props.length) return undefined;

    const targetVal = parseFloat(bareMatch[1]);
    const rowPropLc = rowProperty ? String(rowProperty).toLowerCase() : null;

    let propMatch = null;
    // Strategy 1: exact property name match
    if (rowPropLc) {
      propMatch = props.find(pp => pp && pp.property && String(pp.property).toLowerCase() === rowPropLc);
    }
    // Strategy 2: partial property name match (substring either direction)
    if (!propMatch && rowPropLc) {
      propMatch = props.find(pp => {
        if (!pp || !pp.property) return false;
        const ppLc = String(pp.property).toLowerCase();
        return ppLc.includes(rowPropLc) || rowPropLc.includes(ppLc);
      });
    }
    // Strategy 3: match by numeric required_value (assumes spec values are
    // distinct enough within a product that this rarely collides)
    if (!propMatch && isFinite(targetVal)) {
      propMatch = props.find(pp => {
        if (!pp || pp.required_value == null) return false;
        const val = parseFloat(String(pp.required_value));
        return isFinite(val) && Math.abs(val - targetVal) < 0.001;
      });
    }

    if (!propMatch || !propMatch.comparator) return undefined;
    // Accept any common comparator phrasing — the extractor sometimes writes
    // "minimum"/"min"/">" instead of ">=" (and same for max). We treat all
    // greater-or-equal-style comparators as min, less-or-equal as max.
    const cmpRaw = String(propMatch.comparator).toLowerCase().trim();
    const isMin = ['>=', '>', '≥', 'min', 'minimum', 'gte', 'at least'].includes(cmpRaw);
    const isMax = ['<=', '<', '≤', 'max', 'maximum', 'lte', 'at most'].includes(cmpRaw);
    if (isMin) specComparator = 'min';
    else if (isMax) specComparator = 'max';
    else if (cmpRaw === '=') {
      // Construction-spec domain default. The extractor often writes "=" when
      // the spec lists a numerical value without an explicit min/max keyword,
      // but in construction practice these have implicit conventions.
      // Derive from the property name. If the property name doesn't match a
      // known min or max convention, return undefined (don't guess).
      const propLc = (propMatch.property || rowProperty || '').toLowerCase();
      const minProps = ['compressive_strength', 'tensile_strength', 'tear_resistance', 'density',
        'thickness', 'weight_per_square', 'r_value', 'r_value_per_inch', 'thermal_resistance',
        'pull_out_strength', 'peel_strength', 'elongation', 'closed_cell_content',
        'warranty_years', 'mold_resistance', 'flash_point'];
      const maxProps = ['water_absorption', 'surface_water_absorption', 'water_vapor_permeance',
        'permeance', 'voc_content', 'smoke_developed', 'water_uptake', 'moisture_absorption',
        'water_vapor_transmission'];
      if (minProps.some(p => propLc.includes(p))) specComparator = 'min';
      else if (maxProps.some(p => propLc.includes(p))) specComparator = 'max';
      else return undefined;
    }
    else return undefined; // "approximately", "range" — can't compute compliance for ranges
    specValue = targetVal;
  }
  if (!isFinite(specValue)) return undefined;

  // Parse Soprema range — strip leading ~/approx, look for "X-Y" pattern.
  const sopr = String(sopremaProvides).trim().replace(/^[~≈≃]+/, '').trim();
  const rangeMatch = sopr.match(/^([\d.]+)\s*[-–—]\s*([\d.]+)/);
  if (!rangeMatch) return undefined; // Not a range → matcher's decision stands.

  const rangeLow = parseFloat(rangeMatch[1]);
  const rangeHigh = parseFloat(rangeMatch[2]);
  if (!isFinite(rangeLow) || !isFinite(rangeHigh)) return undefined;

  if (specComparator === 'min') {
    if (rangeLow >= specValue) return true;     // Case A: entire range meets min
    if (rangeHigh < specValue) return false;    // Case B: entire range fails min
    return null;                                // Case E: straddles
  } else {
    if (rangeHigh <= specValue) return true;    // Case C: entire range meets max
    if (rangeLow > specValue) return false;     // Case D: entire range fails max
    return null;                                // Case E: straddles
  }
}

function buildSubRequestHTML(data) {
  const subs = data.proposedSubstitutions || [];
  const footnotes = []; // collected across all subs, rendered at the end

  // Build a lookup of citation per spec product. Citations live on
  // `lastExtracted.products[].citations[]` (matched data has citations
  // stripped before the matcher to save tokens). Key by manufacturer + name.
  const citationLookup = new Map();
  if (lastExtracted && Array.isArray(lastExtracted.products)) {
    lastExtracted.products.forEach(p => {
      if (!p || !p.citations || !p.citations.length) return;
      const key = `${(p.manufacturer || '').toLowerCase()}::${(p.product_name || '').toLowerCase()}`;
      const c = p.citations[0];
      citationLookup.set(key, { pageNumber: c.pageNumber, sectionTitle: c.sectionTitle, quote: c.quote });
    });
  }

  // For each substitution index, look up the citation by matching against
  // currentMatchedData.matches[i].spec_product (which we know reliably has
  // product_name and manufacturer). Don't depend on data.specifiedProducts
  // because Claude has been known to leave those fields empty.
  const fallbackCitations = (subs).map((_, subIdx) => {
    const matchEntry = currentMatchedData?.matches?.[subIdx];
    const sp = matchEntry?.spec_product;
    if (!sp) return null;
    const key = `${(sp.manufacturer || '').toLowerCase()}::${(sp.product_name || '').toLowerCase()}`;
    return citationLookup.get(key) || null;
  });

  // Aggregate coverage summary across the whole form. We re-tally per-sub
  // below and combine into a global "Data sources" line in submission notes.
  const totals = { fromCatalog: 0, fromGK: 0, missing: 0, totalRows: 0 };

  const subsHTML = subs.map((sub, subIdx) => {
    // Prefer the new property_comparison; fall back to legacy comparisonPoints
    // for sub-requests generated before the rebuild.
    const useNewFormat = Array.isArray(sub.property_comparison) && sub.property_comparison.length > 0;

    // Per-substitution coverage tally — counts data_status across rows so we
    // can render a quick honesty badge under each substitution heading.
    // Computed in JS rather than asked of the model: cheaper, more reliable,
    // and the model can't disagree with what's in its own output.
    const subTally = { fromCatalog: 0, fromGK: 0, missing: 0 };
    if (useNewFormat) {
      sub.property_comparison.forEach(row => {
        const s = row.data_status;
        if (s === 'from_catalog') subTally.fromCatalog++;
        else if (s === 'from_general_knowledge') subTally.fromGK++;
        else if (s === 'missing') subTally.missing++;
        totals.totalRows++;
      });
      totals.fromCatalog += subTally.fromCatalog;
      totals.fromGK += subTally.fromGK;
      totals.missing += subTally.missing;
    }

    let compTableHTML = '';

    if (useNewFormat) {
      const rows = sub.property_comparison.map((row, rowIdx) => {
        // Override matcher's compliance decision for general-knowledge ranges
        // where we can compute the answer deterministically. The model has been
        // unreliable on the straddle case — flips between optimistic ✓ and
        // pessimistic ✗ depending on intuition rather than following Case A-E.
        // JS does the math here so the user always gets the same answer for
        // the same inputs.
        //
        // We pass spec_product as a fallback so the parser can recover the
        // comparator if the matcher dropped "min"/"max" from spec_required
        // (e.g. wrote "3.2" instead of "3.2 min" — observed in test_16).
        if (row.data_status === 'from_general_knowledge') {
          const specProductFallback = currentMatchedData?.matches?.[subIdx]?.spec_product;
          const computed = computeRangeComplianceForGK(
            row.spec_required,
            row.soprema_provides,
            row.property,
            specProductFallback
          );
          if (computed !== undefined && computed !== row.compliant) {
            row.compliant = computed;
          }
        }

        // Compliance cell — three states + a fourth visual variant for
        // general-knowledge values where compliance can't be definitively
        // determined. The "?" with tooltip distinguishes "estimate, may not
        // meet spec" from the plain "—" used for missing data.
        let compliantCell;
        if (row.compliant === true) {
          compliantCell = '<td class="compliant">✓</td>';
        } else if (row.compliant === false) {
          compliantCell = '<td class="non-compliant">✗</td>';
        } else if (row.data_status === 'from_general_knowledge') {
          compliantCell = '<td class="pending-gk" title="Industry-standard estimate — actual Soprema value may meet or fall short of spec; see footnote.">?</td>';
        } else {
          compliantCell = '<td class="pending">—</td>';
        }

        // Visual distinction: catalog-verified renders normally, general-knowledge
        // gets a dotted underline (purely visual cue — the verification footnote
        // does the substantive work), missing renders as italicized "not in catalog".
        const gkClass = row.data_status === 'from_general_knowledge' ? ' general-knowledge-cell' : '';
        const sopremaCell = row.soprema_provides == null || row.soprema_provides === ''
          ? '<td class="missing-data"><em>not in catalog</em></td>'
          : `<td contenteditable="true" class="ef${gkClass}">${escapeHtml(String(row.soprema_provides))}</td>`;

        // Footnote marker for missing-data and from-general-knowledge rows
        let marker = '';
        if (row.data_status === 'missing' || row.data_status === 'from_general_knowledge') {
          const noteText = row.note || (row.data_status === 'missing'
            ? 'Catalog does not have data for this property — verify against current Soprema product datasheet.'
            : 'Value drawn from general product knowledge — verify against current Soprema product datasheet.');
          footnotes.push({ marker: footnotes.length + 1, text: noteText });
          marker = `<sup class="footnote-marker">${footnotes.length}</sup>`;
        }

        const standardCell = row.standard
          ? `<td>${escapeHtml(row.standard)}</td>`
          : '<td class="muted">—</td>';

        const unitCell = row.unit
          ? `<td>${escapeHtml(row.unit)}</td>`
          : '<td class="muted">—</td>';

        // Citation: prefer per-property citation from Claude. If missing,
        // fall back to the spec_product's primary citation (collected above).
        const citationData = (row.citation && row.citation.pageNumber)
          ? row.citation
          : fallbackCitations[subIdx] || null;
        const citationCell = citationData && citationData.pageNumber
          ? `<td class="citation-cell" title="${escapeAttr((citationData.quote || '').slice(0, 200))}">p. ${escapeHtml(String(citationData.pageNumber))}</td>`
          : '<td class="muted">—</td>';

        return `
          <tr>
            <td contenteditable="true" class="ef">${escapeHtml(row.property_label || row.property)}${marker}</td>
            ${standardCell}
            ${unitCell}
            <td contenteditable="true" class="ef">${escapeHtml(String(row.spec_required || ''))}</td>
            ${sopremaCell}
            ${compliantCell}
            ${citationCell}
          </tr>`;
      }).join('');

      compTableHTML = `
        <h4>Property-by-property comparison</h4>
        <table class="comparison-table comparison-table-detailed">
          <thead>
            <tr>
              <th>Property</th>
              <th>Standard</th>
              <th>Unit</th>
              <th>Spec required</th>
              <th>Soprema provides</th>
              <th>Compliant</th>
              <th>Cite</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
    } else if (Array.isArray(sub.comparisonPoints) && sub.comparisonPoints.length > 0) {
      // Legacy fallback for old-format sub-requests
      const compRows = sub.comparisonPoints.map(pt => `
        <tr>
          <td contenteditable="true" class="ef">${escapeHtml(pt.attribute || '')}</td>
          <td contenteditable="true" class="ef">${escapeHtml(pt.specified || '')}</td>
          <td contenteditable="true" class="ef">${escapeHtml(pt.proposed || '')}</td>
          <td class="${pt.compliant ? 'compliant' : 'non-compliant'}">${pt.compliant ? '✓' : '✗'}</td>
        </tr>`).join('');

      compTableHTML = `
        <h4>Point-by-point comparison</h4>
        <table class="comparison-table">
          <thead>
            <tr><th>Attribute</th><th>Specified</th><th>Proposed (Soprema)</th><th>Compliant</th></tr>
          </thead>
          <tbody>${compRows}</tbody>
        </table>`;
    }

    const docsHTML = (sub.supportingDocuments || []).map(doc =>
      `<li><strong>${escapeHtml(doc.type)}:</strong> ${escapeHtml(doc.description)}</li>`
    ).join('');

    // Per-sub coverage badge — only shown when there's a property_comparison
    // table to summarize. Reads as: "5 catalog-verified · 2 industry-standard · 1 unknown"
    // so the architect knows what they're looking at before reading the table.
    const subTotalRows = subTally.fromCatalog + subTally.fromGK + subTally.missing;
    const coverageBadge = subTotalRows > 0
      ? `<div class="coverage-badge">
           <span class="cb-catalog">${subTally.fromCatalog} catalog-verified</span>
           ${subTally.fromGK > 0 ? `<span class="cb-divider">·</span><span class="cb-gk">${subTally.fromGK} industry-standard</span>` : ''}
           ${subTally.missing > 0 ? `<span class="cb-divider">·</span><span class="cb-missing">${subTally.missing} unverified</span>` : ''}
         </div>`
      : '';

    return `
      <div class="substitution-block">
        <h3 class="sub-heading">Proposed substitution</h3>
        ${coverageBadge}
        <div class="info-grid">
          <div><span class="label">Manufacturer:</span> <span contenteditable="true" class="ef">${escapeHtml(sub.manufacturer)}</span></div>
          <div><span class="label">Product Name:</span> <span contenteditable="true" class="ef">${escapeHtml(sub.productName)}</span></div>
          ${sub.productId ? `<div><span class="label">Product ID:</span> <span contenteditable="true" class="ef">${escapeHtml(sub.productId)}</span></div>` : ''}
          <div class="full-width"><span class="label">Description:</span> <span contenteditable="true" class="ef">${escapeHtml(sub.description || '')}</span></div>
          <div class="full-width"><span class="label">Reason for Substitution:</span> <span contenteditable="true" class="ef">${escapeHtml(sub.reason || '')}</span></div>
        </div>

        ${compTableHTML}

        ${sub.affectedDrawingsAndSpecs && sub.affectedDrawingsAndSpecs !== 'None' ? `
        <h4>Affected drawings / spec sections</h4>
        <p>${escapeHtml(sub.affectedDrawingsAndSpecs)}</p>` : ''}

        <h4>Supporting documentation</h4>
        <ul>${docsHTML}</ul>
      </div>`;
  }).join('');

  // Render the specifiedProducts list with three layers of fallback:
  //   1. data.specifiedProducts[i] (Claude's output — may be blank)
  //   2. currentMatchedData.matches[i].spec_product (only aligned for matched indices)
  //   3. lastExtracted.products[i] (the original extract — most reliable, same length)
  const specifiedHTML = (data.specifiedProducts || []).map((p, idx) => {
    const matchEntry   = currentMatchedData?.matches?.[idx]?.spec_product;
    const extractEntry = lastExtracted?.products?.[idx];
    const manufacturer = (p.manufacturer && p.manufacturer.trim())
      || matchEntry?.manufacturer
      || extractEntry?.manufacturer
      || '';
    const productName  = (p.productName  && p.productName.trim())
      || matchEntry?.product_name
      || extractEntry?.product_name
      || '';
    const description  = p.description || extractEntry?.specifications || '';
    return `<li><strong>${escapeHtml(manufacturer)} — ${escapeHtml(productName)}:</strong> ${escapeHtml(description)}</li>`;
  }).join('');

  // Form-level data sources summary. Aggregates the per-row data_status
  // counts across the whole substitution request so the architect sees
  // upfront how many claims are PDS-verified vs industry-standard vs
  // unverified. This is honesty-as-a-feature: rather than hiding the
  // gaps, we surface them with exact counts.
  const sourcesSummary = totals.totalRows > 0
    ? `<div class="data-sources-summary">
         <strong>Substitution data sources:</strong>
         ${totals.fromCatalog} of ${totals.totalRows} properties verified directly from Soprema catalog data${totals.fromGK > 0 ? `; ${totals.fromGK} industry-standard values pending PDS verification` : ''}${totals.missing > 0 ? `; ${totals.missing} without published Soprema data` : ''}.
         ${totals.fromGK > 0 || totals.missing > 0 ? 'See verification footnotes for details.' : ''}
       </div>`
    : '';

  // Submission notes — short, supplementary. Replaces the old narrative-heavy
  // `technicalNarrative` block which competed with the property-comparison
  // table for the architect's attention.
  const notesHTML = data.submissionNotes
    ? `<div class="narrative-block">
         <h3 class="section-heading">Submission notes</h3>
         ${sourcesSummary}
         <p contenteditable="true" class="ef">${escapeHtml(data.submissionNotes).replace(/\n\n/g, '</p><p>')}</p>
       </div>`
    : data.technicalNarrative
      ? `<div class="narrative-block">
           <h3 class="section-heading">Technical narrative</h3>
           ${sourcesSummary}
           <p contenteditable="true" class="ef">${escapeHtml(data.technicalNarrative).replace(/\n\n/g, '</p><p>')}</p>
         </div>`
      : (sourcesSummary
          ? `<div class="narrative-block">
               <h3 class="section-heading">Submission notes</h3>
               ${sourcesSummary}
             </div>`
          : '');

  // Footnotes block — explains data-status flags from the comparison tables
  const footnotesHTML = footnotes.length > 0
    ? `<div class="footnotes-block">
         <h4>Notes</h4>
         <ol>${footnotes.map(f => `<li>${escapeHtml(f.text)}</li>`).join('')}</ol>
       </div>`
    : '';

  return `
    <div class="sub-request-doc">
      <div class="form-header">
        <h1>${escapeHtml(data.formTitle || 'SUBSTITUTION REQUEST FORM')}</h1>
        <p class="phase-label">For substitution requests ${escapeHtml(data.biddingPhase || 'prior to bidding')}</p>
      </div>

      <table class="info-table">
        <tr><td class="info-label">Project</td><td contenteditable="true" class="ef">${escapeHtml(data.projectName)}</td></tr>
        <tr><td class="info-label">Spec Section</td><td contenteditable="true" class="ef">${escapeHtml(data.specSection)}</td></tr>
        <tr><td class="info-label">Addressed To</td><td contenteditable="true" class="ef">${escapeHtml(data.addressedTo)}</td></tr>
        <tr><td class="info-label">Submitted By</td><td contenteditable="true" class="ef">${escapeHtml(data.submittedBy)}</td></tr>
        <tr><td class="info-label">Date</td><td contenteditable="true" class="ef">${escapeHtml(data.date || '')}</td></tr>
      </table>

      <h3 class="section-heading">Products being substituted</h3>
      <ul class="specified-list">${specifiedHTML}</ul>

      ${subsHTML}

      ${footnotesHTML}

      ${notesHTML}

      <div class="certification-block">
        <p class="certification-text" contenteditable="true" class="ef">${escapeHtml(data.certificationStatement || '')}</p>
        <div class="signature-grid">
          <div class="sig-line"><span>Submitted By</span><div class="line"></div></div>
          <div class="sig-line"><span>Date</span><div class="line"></div></div>
        </div>
      </div>
    </div>`;
}

// ── Build a self-contained printable HTML document ────────────────────────────
// ── Cover letter — formal one-page intro to the architect ────────────────────
// Generated from project info + matched products. Becomes page 1 of the
// bundled submission package. Template-driven, no extra Claude call.
//
// `subRequestData` is the generated substitution-request payload (the same
// thing passed to renderSubstitutionRequest). Used to compute the data
// sources sentence — Davis's transparency flex up front.
function buildCoverLetterHTML(projectInfo, matched, subRequestData) {
  const today =
    projectInfo.date ||
    new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  // List of substitutions for the body of the letter. Build the spec-side
  // label with graceful fallback when product_name is missing — the spec
  // extractor sometimes returns "GAF — :" with no product name. Prefer
  // product_name → product_type → specifications → manufacturer alone.
  const subs = (matched?.matches || []).filter(
    (m) => m && m.spec_product && m.soprema_match && m.soprema_match.product_name
  );
  const substitutionsList = subs.length
    ? '<ul>' +
      subs
        .map((m) => {
          const specMfr = (m.spec_product.manufacturer || '').trim();
          const specName = (m.spec_product.product_name || '').trim();
          const specType = (m.spec_product.product_type || '').trim();
          const sopName = (m.soprema_match.product_name || '').trim();

          // Choose the best spec-side label given what's available.
          let specLabel;
          if (specName) {
            specLabel = specMfr ? `${specMfr} ${specName}` : specName;
          } else if (specType) {
            // No product name — describe by category. Title-case the type.
            const typeWord = specType.replace(/\b\w/g, (c) => c.toUpperCase());
            specLabel = specMfr ? `${specMfr} ${typeWord}` : typeWord;
          } else if (specMfr) {
            specLabel = specMfr;
          } else {
            specLabel = '(unnamed specified product)';
          }

          return `<li>${escapeHtml(specLabel)} → Soprema <strong>${escapeHtml(sopName)}</strong></li>`;
        })
        .join('') +
      '</ul>'
    : '';

  // Data sources sentence — quote the actual counts from the generated
  // substitution request so the architect sees the methodology upfront.
  // Same tally logic as the form-level summary in buildSubRequestHTML.
  let dataSourcesSentence = '';
  if (subRequestData && Array.isArray(subRequestData.proposedSubstitutions)) {
    const totals = { fromCatalog: 0, fromGK: 0, missing: 0, total: 0 };
    subRequestData.proposedSubstitutions.forEach((sub) => {
      (sub.property_comparison || []).forEach((row) => {
        const s = row && row.data_status;
        if (s === 'from_catalog') totals.fromCatalog++;
        else if (s === 'from_general_knowledge') totals.fromGK++;
        else if (s === 'missing') totals.missing++;
        totals.total++;
      });
    });
    if (totals.total > 0) {
      const parts = [
        totals.fromCatalog + ' verified directly against Soprema\'s published catalog data',
      ];
      if (totals.fromGK > 0) {
        parts.push(totals.fromGK + ' flagged with industry-standard reference values pending PDS verification');
      }
      if (totals.missing > 0) {
        parts.push(totals.missing + ' marked for direct verification (no published Soprema data)');
      }
      dataSourcesSentence =
        '<p>Of ' + totals.total + ' performance requirements evaluated: ' +
        parts.join('; ') + '.</p>';
    }
  }

  // Parse "Davis Haddock, Soprema Sales Rep" format if present;
  // otherwise default the title from the per-customer brand config (so
  // Carlisle/GAF/JM builds default to their own rep titles, not Soprema's).
  const submitterParts = String(projectInfo.submittedBy || '').split(/,\s*/);
  const submitterName = submitterParts[0] || projectInfo.submittedBy || '';
  const submitterTitle =
    submitterParts.slice(1).join(', ').trim() ||
    (cipherBrand.name + ' ' + cipherBrand.repTitle);

  // Pull a salutation from the addressedTo if it looks like "Name, Firm" — otherwise
  // fall back to "Architect"
  const addresseeName = String(projectInfo.addressedTo || '').split(/,|—|–/)[0].trim() || 'Architect';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Cover Letter — Substitution Request</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: Arial, sans-serif;
    font-size: 11pt;
    color: #1a1a1a;
    background: white;
    padding: 0.85in 0.85in 1in 0.85in;
    line-height: 1.5;
  }
  .letterhead { border-bottom: 2px solid #003a70; padding-bottom: 8px; margin-bottom: 36px; }
  .letterhead .brand { font-size: 14pt; font-weight: bold; color: #003a70; letter-spacing: 0.04em; }
  .letterhead .tagline { font-size: 9.5pt; color: #555; margin-top: 2px; }
  .date { margin-bottom: 28px; }
  .recipient { margin-bottom: 22px; line-height: 1.4; white-space: pre-line; }
  .subject { font-weight: bold; margin-bottom: 24px; line-height: 1.4; }
  p { margin-bottom: 14px; text-align: justify; }
  ul { margin: 12px 0 18px 24px; }
  li { margin-bottom: 6px; line-height: 1.4; }
  .signature-block { margin-top: 40px; line-height: 1.5; }
  .signature-line { margin-top: 36px; border-bottom: 1px solid #333; width: 240px; height: 1px; margin-bottom: 8px; }
  .signature-name { font-weight: bold; }
  @page { margin: 0; size: Letter; }
</style>
</head>
<body>
  <div class="letterhead">
    <div class="brand">SOPREMA</div>
    <div class="tagline">Substitution Request — ${escapeHtml(projectInfo.specSection || 'Roofing Spec')}</div>
  </div>

  <div class="date">${escapeHtml(today)}</div>

  <div class="recipient">${escapeHtml(projectInfo.addressedTo || '[Architect]')}</div>

  <div class="subject">
    Re: ${escapeHtml(projectInfo.projectName || 'Project')} — Substitution Request, Spec Section ${escapeHtml(projectInfo.specSection || '')}
  </div>

  <p>Dear ${escapeHtml(addresseeName)},</p>

  <p>
    Please find enclosed our request to substitute the products specified in
    Section ${escapeHtml(projectInfo.specSection || '')} with equivalent Soprema products. Each
    substitution has been evaluated against the spec's stated performance
    requirements; results are summarized in the attached Substitution Request
    Form with a property-by-property comparison table for every proposed
    substitute, including citations back to the specification source for
    independent verification.
  </p>

  ${
    subs.length > 0
      ? `<p>The following substitutions are proposed:</p>${substitutionsList}`
      : ''
  }

  ${dataSourcesSentence}

  <p>
    Soprema product data sheets and supporting compliance documentation
    follow this letter and the substitution request form. Should you
    require additional verification or have questions about any individual
    substitution, please contact me directly.
  </p>

  <p>Sincerely,</p>

  <div class="signature-block">
    <div class="signature-line"></div>
    <div class="signature-name">${escapeHtml(submitterName || '[Submitted By]')}</div>
    <div>${escapeHtml(submitterTitle)}</div>
    <div>Soprema</div>
  </div>
</body>
</html>`;
}

function buildPrintableHTML(bodyContent) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Substitution Request</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 10pt; color: #1a1a1a; background: white; padding: 0.5in; }
  h1 { font-size: 16pt; text-align: center; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
  h3 { font-size: 11pt; margin: 16px 0 6px; border-bottom: 1px solid #999; padding-bottom: 3px; }
  h4 { font-size: 10pt; margin: 12px 0 4px; color: #333; }
  p  { margin: 6px 0; line-height: 1.5; }
  .phase-label  { text-align: center; font-style: italic; color: #555; margin-bottom: 14px; }
  .section-heading { color: #1a1a1a; text-transform: uppercase; letter-spacing: 0.04em; font-weight: bold; }
  .info-table   { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  .info-table td { border: 1px solid #ccc; padding: 5px 8px; font-size: 9.5pt; }
  .info-label   { font-weight: bold; width: 140px; background: #f5f5f5; }
  .sub-heading  { background: #333; color: white; padding: 5px 8px; font-size: 10.5pt; margin: 16px 0 8px; letter-spacing: 0.02em; }
  .info-grid    { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 20px; margin-bottom: 12px; font-size: 9.5pt; }
  .info-grid .full-width { grid-column: 1 / -1; }
  .label        { font-weight: bold; margin-right: 4px; }
  .comparison-table { width: 100%; border-collapse: collapse; font-size: 9pt; margin-bottom: 10px; }
  .comparison-table th { background: #333; color: white; padding: 5px 7px; text-align: left; letter-spacing: 0.02em; }
  .comparison-table td { border: 1px solid #ccc; padding: 4px 7px; vertical-align: top; }
  .comparison-table tr:nth-child(even) td { background: #f9f9f9; }
  .comparison-table-detailed { font-size: 8.5pt; }
  .comparison-table-detailed td.muted { color: #999; text-align: center; }
  .comparison-table-detailed td.missing-data { color: #888; font-style: italic; text-align: center; }
  .comparison-table-detailed td.citation-cell { font-family: monospace; font-size: 8pt; color: #555; }
  .comparison-table-detailed sup.footnote-marker { color: #555; font-size: 7pt; padding-left: 2px; }
  .footnotes-block { margin-top: 14px; padding: 8px 12px; background: #f6f6f6; border-left: 2px solid #999; font-size: 8.5pt; }
  .footnotes-block h4 { font-size: 9pt; margin-bottom: 4px; color: #333; }
  .footnotes-block ol { margin: 4px 0 0 18px; padding: 0; }
  .footnotes-block li { margin-bottom: 3px; line-height: 1.4; color: #444; }
  .compliant    { color: #1a1a1a; font-weight: bold; text-align: center; }
  .non-compliant{ color: #1a1a1a; font-weight: bold; text-align: center; font-style: italic; }
  .pending      { color: #888; text-align: center; }
  ul            { margin: 6px 0 10px 18px; }
  li            { margin-bottom: 4px; line-height: 1.4; }
  .specified-list li { font-size: 9.5pt; }
  .narrative-block { margin-top: 16px; padding: 10px; background: #f6f6f6; border-left: 3px solid #555; }
  .certification-block { margin-top: 24px; padding: 12px; border: 1px solid #ccc; background: #f9f9f9; }
  .certification-text  { font-style: italic; font-size: 9pt; margin-bottom: 18px; }
  .signature-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 30px; }
  .sig-line span  { display: block; font-size: 8.5pt; color: #555; margin-bottom: 4px; }
  .line           { border-bottom: 1px solid #333; height: 28px; }
  @media print {
    body { padding: 0; }
    @page { margin: 0.6in 0.5in 0.7in 0.5in; }
    @page :left  { @top-left  { content: "Substitution Request — ${cipherBrand.name}"; font-family: Arial; font-size: 8.5pt; color: #777; } }
    @page :right { @top-right { content: "Substitution Request — ${cipherBrand.name}"; font-family: Arial; font-size: 8.5pt; color: #777; } }
    @page { @bottom-right { content: "Page " counter(page) " of " counter(pages); font-family: Arial; font-size: 8.5pt; color: #777; } }
    .substitution-block { page-break-inside: avoid; }
    .footnotes-block { page-break-inside: avoid; }
    h1 { page-break-after: avoid; }
    h3.sub-heading { page-break-after: avoid; }
  }
</style>
</head>
<body>${bodyContent}</body>
</html>`;
}

// ── Utility: escape HTML (used inside sub-request builder) ────────────────────
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ══════════════════════════════════════════════════════════════════════════════
// SESSION HISTORY
// ══════════════════════════════════════════════════════════════════════════════
let sessionCache = [];

async function initSessions() {
  sessionCache = (await window.api.loadSessions()) || [];
  renderSessionHistory();
}

function renderSessionHistory() {
  const container = document.getElementById('session-history-container');
  if (!container) return;
  if (!sessionCache.length) { container.innerHTML = ''; return; }
  container.innerHTML = `
    <div class="session-history">
      <div class="session-history-title">Recent Analyses</div>
      ${sessionCache.map(s => `
        <div class="session-item">
          <button class="session-delete-btn" onclick="deleteSession(${s.id})" title="Remove">&times;</button>
          <div class="session-info">
            <div class="session-project">${escapeHtml(s.projectName || 'Untitled Project')}</div>
            <div class="session-meta">${escapeHtml(s.filename)} &bull; ${new Date(s.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
          </div>
          <button class="session-restore-btn" onclick="restoreSession(${s.id})">Restore</button>
        </div>
      `).join('')}
    </div>
  `;
}

async function saveCurrentSession(data) {
  const parts = (selectedFilePath || '').split('/');
  const fname = parts[parts.length - 1] || 'unknown.pdf';
  const session = {
    id: Date.now(),
    date: new Date().toISOString(),
    filename: fname,
    projectName: data.extracted.project_name || 'Untitled Project',
    data,
  };
  sessionCache.unshift(session);
  sessionCache = sessionCache.slice(0, 15);
  await window.api.saveSession(session);
  renderSessionHistory();
}

async function deleteSession(id) {
  sessionCache = sessionCache.filter(s => s.id !== id);
  await window.api.deleteSession(id);
  renderSessionHistory();
}

function restoreSession(id) {
  const session = sessionCache.find(s => s.id === id);
  if (!session) return;
  renderResults(session.data);
  showSection('results');
  showStep3(session.data.matched);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

initSessions();

// ══════════════════════════════════════════════════════════════════════════════
// MANUAL PRODUCT OVERRIDE
// ══════════════════════════════════════════════════════════════════════════════
let catalogProducts         = null;
let overrideMatchIndex      = null;
let currentOverrideProducts = [];

async function openOverrideModal(matchIndex) {
  overrideMatchIndex = matchIndex;
  if (!catalogProducts) {
    catalogProducts = await window.api.getCatalogProducts();
  }
  const search = document.getElementById('override-search');
  const list   = document.getElementById('override-list');
  if (search) search.value = '';
  renderOverrideList(catalogProducts, list);
  document.getElementById('override-modal').classList.remove('hidden');
  if (search) search.focus();
}

function renderOverrideList(products, listEl) {
  if (!listEl) return;
  currentOverrideProducts = (products || []).slice(0, 100);
  listEl.innerHTML = currentOverrideProducts.map((p, i) => `
    <div class="override-item" data-idx="${i}">
      <div class="override-name">${escapeHtml(p.name)}</div>
      ${p.type ? `<div class="override-type">${escapeHtml(p.type)}</div>` : ''}
    </div>
  `).join('');
}

document.getElementById('override-list')?.addEventListener('click', (e) => {
  const item = e.target.closest('.override-item');
  if (!item) return;
  const p = currentOverrideProducts[parseInt(item.dataset.idx)];
  if (p) selectOverride(p.id || '', p.name || '', p.type || '');
});

document.getElementById('override-search')?.addEventListener('input', (e) => {
  if (!catalogProducts) return;
  const q = e.target.value.toLowerCase();
  const filtered = q
    ? catalogProducts.filter(p => (p.name || '').toLowerCase().includes(q) || (p.type || '').toLowerCase().includes(q))
    : catalogProducts;
  renderOverrideList(filtered, document.getElementById('override-list'));
});

document.getElementById('override-close')?.addEventListener('click', () => {
  document.getElementById('override-modal').classList.add('hidden');
});

document.getElementById('override-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'override-modal') document.getElementById('override-modal').classList.add('hidden');
});

function selectOverride(productId, productName, productType) {
  if (overrideMatchIndex === null || !currentMatchedData) return;
  const match = currentMatchedData.matches[overrideMatchIndex];
  if (match) {
    match.soprema_match = {
      ...match.soprema_match,
      product_name: productName,
      objectID:     productId,
      product_type: productType || match.soprema_match.product_type,
      confidence:   'manual',
      key_specs:    'Manually selected by rep',
    };
  }
  document.getElementById('override-modal').classList.add('hidden');
  overrideMatchIndex = null;
  if (lastExtracted) renderResults({ extracted: lastExtracted, matched: currentMatchedData });
}

// ══════════════════════════════════════════════════════════════════════════════
// EMAIL SUBSTITUTION REQUEST
// ══════════════════════════════════════════════════════════════════════════════
document.getElementById('emailSubRequestBtn')?.addEventListener('click', () => {
  const modal = document.getElementById('email-modal');
  const input = document.getElementById('email-to-input');
  // Only pull from the form field — never from localStorage
  const formEmail = document.getElementById('architectEmail')?.value?.trim();
  if (input) input.value = formEmail || '';
  modal.classList.remove('hidden');
  if (input) input.focus();
});

document.getElementById('email-close')?.addEventListener('click', () => {
  document.getElementById('email-modal').classList.add('hidden');
});

document.getElementById('email-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'email-modal') document.getElementById('email-modal').classList.add('hidden');
});

document.getElementById('email-send-btn')?.addEventListener('click', async () => {
  const input = document.getElementById('email-to-input');
  const to    = input?.value?.trim();
  if (!to) { alert("Please enter the architect's email address."); return; }
  // Write back to the form field so it stays available for the rest of this session
  const archField = document.getElementById('architectEmail');
  if (archField) archField.value = to;

  const projectName = document.getElementById('projectName')?.value?.trim() || 'the project';
  const specSection = document.getElementById('specSection')?.value?.trim() || '';
  const submittedBy = document.getElementById('submittedBy')?.value?.trim() || 'Soprema';

  const subject = 'Substitution Request \u2013 ' + projectName + (specSection ? ' | ' + specSection : '');
  const body    = 'Dear Architect,\n\nPlease find attached our Substitution Request for ' + projectName +
    (specSection ? ', ' + specSection : '') + '.\n\nSoprema is pleased to offer equivalent or superior ' +
    'products as detailed in the attached form. Our proposed substitutions meet or exceed the performance ' +
    'requirements of your specification.\n\nPlease do not hesitate to reach out with any questions.\n\n' +
    'Best regards,\n' + submittedBy;

  const result = await window.api.openEmail({ to, subject, body });
  if (result.success) {
    document.getElementById('email-modal').classList.add('hidden');
    const btn = document.getElementById('emailSubRequestBtn');
    if (btn) {
      btn.textContent = 'Email Opened!';
      setTimeout(() => { btn.textContent = '\u2709 Email to Architect'; }, 2500);
    }
  }
});

/* ==========================================================================
   007 brand link — open website in default browser
   ========================================================================== */
document.getElementById('sidebar-brand-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  const url = e.currentTarget.getAttribute('href') || 'https://007technologies.com';
  window.api.openExternal(url);
});

/* ==========================================================================
   Sidebar navigation — Library, Help, Settings
   ========================================================================== */
document.querySelectorAll('.sidebar-nav').forEach((el) => {
  el.addEventListener('click', () => {
    const key = el.dataset.nav;
    if (key === 'recent')   { openLibraryRecent(); }
    else if (key === 'catalog') { openLibraryCatalog(); }
    else if (key === 'drafts')  { openLibraryDrafts(); }
    else if (key === 'guide')   { openHelpGuide(); }
    else if (key === 'support') { openSupport(); }
    else if (key === 'feedback'){ openFeedback(); }
    else if (key === 'settings'){ openSettings(); }
  });
});

// Clicking a Session step in the sidebar returns to the upload intake screen.
// (We don't allow jumping forward mid-analysis, but "Upload" is always clickable
// as a "start over" affordance.)
document.querySelector('.sidebar-item[data-step="upload"]')?.addEventListener('click', () => {
  const preview = document.getElementById('subRequestPreview');
  if (preview) preview.style.display = 'none';
  showSection('upload');
});

/* ==========================================================================
   LIBRARY — Recent Sessions full view
   Uses the same sessionCache that powers the inline history on the upload
   screen, so mutations propagate everywhere.
   ========================================================================== */
async function openLibraryRecent() {
  showSection('library-recent');

  // Ensure sessionCache is populated (initSessions may not have run yet if
  // the user jumps to Recent before the upload screen renders the inline list)
  if (!sessionCache || sessionCache.length === 0) {
    try { sessionCache = (await window.api.loadSessions()) || []; } catch (e) { /* ignore */ }
  }

  const list   = document.getElementById('library-recent-list');
  const empty  = document.getElementById('library-recent-empty');
  const count  = document.getElementById('library-recent-count');
  const search = document.getElementById('library-recent-search');
  if (!list) return;

  const renderFromCache = (filter = '') => {
    const q = filter.trim().toLowerCase();
    // Search haystack includes the formatted human date too — so Davis can
    // type "april", "2026", "march 12", etc. and find the right session.
    // Each token in the query must match somewhere in the haystack (AND
    // semantics) so "walgreens april" finds a Walgreens job from April even
    // if the project name doesn't include the date.
    const items = q
      ? sessionCache.filter((s) => {
          const dateStr = formatSessionDate(s.date);
          const hay = (
            (s.projectName || '') + ' ' +
            (s.filename || '') + ' ' +
            (dateStr || '')
          ).toLowerCase();
          const tokens = q.split(/\s+/).filter(Boolean);
          return tokens.every((tok) => hay.includes(tok));
        })
      : sessionCache;

    if (!items.length) {
      list.innerHTML = '';
      empty?.classList.remove('hidden');
      if (count) count.textContent = q
        ? '0 matches of ' + sessionCache.length
        : '0 sessions';
      return;
    }
    empty?.classList.add('hidden');
    if (count) {
      count.textContent = q
        ? items.length + ' of ' + sessionCache.length + ' ' +
          (sessionCache.length === 1 ? 'session' : 'sessions') + ' match'
        : items.length + ' session' + (items.length === 1 ? '' : 's');
    }

    list.innerHTML = items.map((s) => {
      const project = escapeHtml(s.projectName || 'Untitled analysis');
      const filename = escapeHtml(s.filename || '');
      const when = formatSessionDate(s.date);
      return `
        <div class="library-card" data-id="${s.id}">
          <div class="library-card-body">
            <div class="library-card-title">${project}</div>
            <div class="library-card-meta">
              ${filename ? `<span class="library-card-filename">${filename}</span>` : ''}
              <span class="library-card-date">${when}</span>
            </div>
          </div>
          <div class="library-card-actions">
            <button class="btn btn-ghost btn-sm" data-act="restore">Restore</button>
            <button class="library-card-delete" data-act="delete" title="Delete">&times;</button>
          </div>
        </div>`;
    }).join('');
  };



  renderFromCache();

  list.onclick = async (e) => {
    const card = e.target.closest('.library-card');
    if (!card) return;
    const id = Number(card.dataset.id);
    const act = e.target.dataset.act;
    if (act === 'delete') {
      if (!confirm('Delete this session?')) return;
      sessionCache = sessionCache.filter((s) => s.id !== id);
      await window.api.deleteSession(id);
      renderFromCache(search?.value || '');
      renderSessionHistory();
    } else {
      const sess = sessionCache.find((s) => s.id === id);
      if (sess) restoreSessionFromLibrary(sess);
    }
  };

  if (search) {
    search.oninput = () => renderFromCache(search.value);
    // Auto-focus when opening — most users come here knowing what they're
    // looking for. Saves a click. Skip if the search has a value already
    // (preserve scroll position on a soft re-open).
    if (!search.value) {
      // Defer to next tick so the section becomes visible before focus —
      // otherwise focus on a still-hidden element is a no-op on some platforms.
      setTimeout(() => { search.focus(); }, 30);
    }
  }
}

// Cmd/Ctrl+F when the Recent Sessions library is visible focuses the search.
// Browsers normally hijack Cmd+F for in-page find, but Electron lets us own it.
document.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (!meta) return;
  if (e.key !== 'f' && e.key !== 'F') return;
  const recentSection = document.getElementById('library-recent-section');
  if (!recentSection || recentSection.classList.contains('hidden')) return;
  const search = document.getElementById('library-recent-search');
  if (!search) return;
  e.preventDefault();
  search.focus();
  search.select();
});

function restoreSessionFromLibrary(sess) {
  if (!sess || !sess.data) {
    alert('This session appears to be incomplete and can\'t be restored.');
    return;
  }
  renderResults(sess.data);
  showSection('results');
  showStep3(sess.data.matched);
}

function formatSessionDate(v) {
  if (!v) return '';
  try {
    const d = new Date(v);
    if (isNaN(d)) return v;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      + ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch (e) { return String(v); }
}

/* ==========================================================================
   LIBRARY — Soprema Catalog browser
   ========================================================================== */
let catalogCache = null;

async function openLibraryCatalog() {
  showSection('library-catalog');
  const list  = document.getElementById('library-catalog-list');
  const empty = document.getElementById('library-catalog-empty');
  const count = document.getElementById('library-catalog-count');
  if (!list) return;

  if (!catalogCache) {
    list.innerHTML = '<div class="library-loading">Loading Soprema catalog…</div>';
    try {
      catalogCache = await window.api.getCatalogProducts() || [];
    } catch (e) {
      catalogCache = [];
    }
  }

  renderCatalog(catalogCache);

  function renderCatalog(items) {
    if (!items.length) {
      list.innerHTML = '';
      empty?.classList.remove('hidden');
      if (count) count.textContent = '0 products';
      return;
    }
    empty?.classList.add('hidden');
    if (count) count.textContent = items.length + ' product' + (items.length === 1 ? '' : 's');

    list.innerHTML = items.map((p) => `
      <div class="catalog-card">
        <div class="catalog-card-name">${escape(p.name || '')}</div>
        ${p.type ? `<div class="catalog-card-type">${escape(p.type)}</div>` : ''}
      </div>
    `).join('');
  }

  const search = document.getElementById('library-catalog-search');
  if (search) {
    search.oninput = () => {
      const q = search.value.trim().toLowerCase();
      if (!q) return renderCatalog(catalogCache);
      const filtered = catalogCache.filter(p => {
        const hay = ((p.name || '') + ' ' + (p.type || '')).toLowerCase();
        return hay.includes(q);
      });
      renderCatalog(filtered);
    };
  }
}

/* ==========================================================================
   LIBRARY — Drafts
   ========================================================================== */
let draftsCache = [];

async function openLibraryDrafts() {
  showSection('library-drafts');
  await refreshDraftsView();
}

async function refreshDraftsView() {
  const list  = document.getElementById('library-drafts-list');
  const empty = document.getElementById('library-drafts-empty');
  const count = document.getElementById('library-drafts-count');
  if (!list) return;

  list.innerHTML = '<div class="library-loading">Loading drafts…</div>';
  try {
    draftsCache = await window.api.loadDrafts() || [];
  } catch (e) {
    draftsCache = [];
  }
  renderDrafts(draftsCache);
  updateDraftsBadge(draftsCache.length);

  function renderDrafts(items) {
    if (!items.length) {
      list.innerHTML = '';
      empty?.classList.remove('hidden');
      if (count) count.textContent = '0 drafts';
      return;
    }
    empty?.classList.add('hidden');
    if (count) count.textContent = items.length + ' draft' + (items.length === 1 ? '' : 's');

    list.innerHTML = items.map((d) => {
      const project = escape(d.projectName || 'Untitled draft');
      const section = escape(d.specSection || '');
      const when = formatSessionDate(d.savedAt);
      return `
        <div class="library-card" data-id="${escape(d.id || '')}">
          <div class="library-card-body">
            <div class="library-card-title">${project}</div>
            <div class="library-card-meta">
              ${section ? `<span class="library-card-filename">${section}</span>` : ''}
              <span class="library-card-date">${when}</span>
            </div>
          </div>
          <div class="library-card-actions">
            <button class="btn btn-ghost btn-sm" data-act="resume">Resume</button>
            <button class="library-card-delete" data-act="delete" title="Delete">&times;</button>
          </div>
        </div>`;
    }).join('');
  }

  list.onclick = async (e) => {
    const card = e.target.closest('.library-card');
    if (!card) return;
    const id = card.dataset.id;
    const act = e.target.dataset.act;
    if (act === 'delete') {
      if (!confirm('Delete this draft?')) return;
      await window.api.deleteDraft(id);
      await refreshDraftsView();
    } else if (act === 'resume') {
      const draft = draftsCache.find(d => d.id === id);
      if (draft) resumeDraft(draft);
    }
  };

  const search = document.getElementById('library-drafts-search');
  if (search) {
    search.oninput = () => {
      const q = search.value.trim().toLowerCase();
      if (!q) return renderDrafts(draftsCache);
      const filtered = draftsCache.filter(d => {
        const hay = ((d.projectName || '') + ' ' + (d.specSection || '')).toLowerCase();
        return hay.includes(q);
      });
      renderDrafts(filtered);
    };
  }
}

function resumeDraft(draft) {
  if (draft.extracted && draft.matched) {
    renderResults({ extracted: draft.extracted, matched: draft.matched });
    showSection('results');
    showStep3(draft.matched);
  } else {
    showSection('results');
  }

  // Track which draft is being edited so subsequent saves overwrite it
  currentDraftId = draft.id || null;

  // Pre-fill the Step 3 form fields
  setTimeout(() => {
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
    setVal('projectName',    draft.projectName);
    setVal('specSection',    draft.specSection);
    setVal('addressedTo',    draft.addressedTo);
    setVal('submittedBy',    draft.submittedBy);
    setVal('architectEmail', draft.architectEmail);
    setVal('subRequestDate', draft.subRequestDate);

    // If the draft included a generated sub-request, restore the preview
    // so the user lands back at the same place they left off.
    if (draft.subRequestData || draft.subRequestHTML) {
      if (draft.subRequestData) {
        lastSubRequestData = draft.subRequestData;
        renderSubstitutionRequest(draft.subRequestData);
      }
      // If the user hand-edited fields in the preview, prefer the saved HTML
      if (draft.subRequestHTML) {
        const container = document.getElementById('subRequestContent');
        if (container) container.innerHTML = draft.subRequestHTML;
        const preview = document.getElementById('subRequestPreview');
        if (preview) {
          preview.style.display = 'block';
          preview.scrollIntoView({ behavior: 'smooth' });
        }
        setSidebarStep('export');
      }
    } else {
      const step3 = document.getElementById('step3');
      if (step3) step3.scrollIntoView({ behavior: 'smooth' });
    }
  }, 100);
}

function updateDraftsBadge(n) {
  const badge = document.getElementById('sidebar-drafts-badge');
  if (!badge) return;
  if (n > 0) {
    badge.textContent = n;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

// Load the drafts badge count at startup
(async () => {
  try {
    const drafts = await window.api.loadDrafts() || [];
    updateDraftsBadge(drafts.length);
  } catch (e) { /* ignore */ }
})();

/* ==========================================================================
   SAVE DRAFT — button injected into Step 3
   ========================================================================== */
async function saveCurrentDraft() {
  const get = (id) => document.getElementById(id)?.value?.trim() || '';
  const projectName = get('projectName');
  if (!projectName) {
    alert('Enter a project name before saving a draft.');
    return;
  }

  // Capture the live, possibly-edited preview HTML (user can click any
  // field in the rendered preview to tweak it before saving).
  const previewContent = document.getElementById('subRequestContent')?.innerHTML || '';

  const draft = {
    id: currentDraftId || null,
    projectName,
    specSection:    get('specSection'),
    addressedTo:    get('addressedTo'),
    submittedBy:    get('submittedBy'),
    architectEmail: get('architectEmail'),
    subRequestDate: get('subRequestDate'),
    extracted:       lastExtracted || null,
    matched:         currentMatchedData || null,
    subRequestData:  lastSubRequestData || null,
    subRequestHTML:  previewContent,
  };
  const result = await window.api.saveDraft(draft);
  if (result?.success) {
    currentDraftId = result.id;
    const btn = document.getElementById('saveDraftBtn');
    if (btn) {
      const prev = btn.textContent;
      btn.textContent = 'Draft saved';
      setTimeout(() => { btn.textContent = prev; }, 1800);
    }
    const drafts = await window.api.loadDrafts();
    updateDraftsBadge(drafts.length);
  }
}

let currentDraftId = null;

document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'saveDraftBtn') {
    saveCurrentDraft();
  }
});

// Called by the analyze click handler at the top of this file to
// reset any per-analysis scratch state (draft id, query thread).
function resetAnalysisEphemeralState() {
  currentDraftId = null;
  lastSubRequestData = null;
  if (typeof queryHistory !== 'undefined') queryHistory.length = 0;
  const thread = document.getElementById('query-thread');
  if (thread) thread.innerHTML = '';
  // Remove any lingering saveDraftBtn from a previous session (it'll be
  // re-injected the next time a request is generated)
  document.getElementById('saveDraftBtn')?.remove();
}

/* ==========================================================================
   HELP — User Guide (markdown rendered inline)
   ========================================================================== */
async function openHelpGuide() {
  showSection('help-guide');
  const container = document.getElementById('help-guide-content');
  if (!container) return;
  container.innerHTML = '<p class="type-muted">Loading guide…</p>';

  try {
    const result = await window.api.readUserGuide();
    if (result?.success && result.content) {
      container.innerHTML = renderMarkdown(result.content);
    } else {
      container.innerHTML = `<div class="empty-state">
        <h3>Guide unavailable</h3>
        <p>${escape(result?.error || 'The user guide file could not be found.')}</p>
        <p>You can view it online at <a href="https://007technologies.com" id="help-web-link">007technologies.com</a>.</p>
      </div>`;
    }
  } catch (err) {
    container.innerHTML = `<p class="type-muted">Error loading guide: ${escape(err.message)}</p>`;
  }
}

/**
 * Minimal markdown → HTML renderer (no external dep).
 * Handles: headings, bold, italic, inline code, fenced code blocks,
 * unordered/ordered lists, links, paragraphs, horizontal rules.
 */
function renderMarkdown(md) {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  // Protect fenced code blocks
  const codeBlocks = [];
  md = md.replace(/```([\s\S]*?)```/g, (m, code) => {
    codeBlocks.push(code);
    return `\u0000CODE${codeBlocks.length - 1}\u0000`;
  });

  const lines = md.split('\n');
  const out = [];
  let inList = null; // 'ul' | 'ol' | null
  let para = [];

  const flushPara = () => {
    if (para.length) {
      out.push('<p>' + inlineMd(para.join(' ')) + '</p>');
      para = [];
    }
  };
  const closeList = () => {
    if (inList) { out.push(`</${inList}>`); inList = null; }
  };

  const inlineMd = (s) => {
    s = esc(s);
    // fenced-block tokens
    s = s.replace(/\u0000CODE(\d+)\u0000/g, (_, i) =>
      `</p><pre class="help-code"><code>${esc(codeBlocks[Number(i)])}</code></pre><p>`);
    // inline code
    s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    // bold
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // italic
    s = s.replace(/(^|[\s(])_([^_]+)_/g, '$1<em>$2</em>');
    s = s.replace(/(^|[\s(])\*([^*]+)\*/g, '$1<em>$2</em>');
    // links
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" data-external="1">$1</a>');
    return s;
  };

  for (const rawLine of lines) {
    const line = rawLine;
    if (/^\s*$/.test(line)) { flushPara(); closeList(); continue; }
    // headings
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara(); closeList();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inlineMd(h[2])}</h${lvl}>`);
      continue;
    }
    // horizontal rule
    if (/^\s*---+\s*$/.test(line)) {
      flushPara(); closeList();
      out.push('<hr>');
      continue;
    }
    // unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      flushPara();
      if (inList !== 'ul') { closeList(); out.push('<ul>'); inList = 'ul'; }
      out.push('<li>' + inlineMd(line.replace(/^\s*[-*]\s+/, '')) + '</li>');
      continue;
    }
    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara();
      if (inList !== 'ol') { closeList(); out.push('<ol>'); inList = 'ol'; }
      out.push('<li>' + inlineMd(line.replace(/^\s*\d+\.\s+/, '')) + '</li>');
      continue;
    }
    // paragraph accumulate
    para.push(line);
  }
  flushPara(); closeList();
  let html = out.join('\n');
  // Restore any code-blocks that missed the inline pass (shouldn't, but safety)
  html = html.replace(/\u0000CODE(\d+)\u0000/g, (_, i) =>
    `<pre class="help-code"><code>${esc(codeBlocks[Number(i)])}</code></pre>`);
  return html;
}

// Links inside help content open externally
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-external]');
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href');
  if (href && /^https?:\/\//i.test(href)) window.api.openExternal(href);
});

/* ==========================================================================
   HELP — Support (mailto)
   ========================================================================== */
function openSupport() {
  const to = 'support@007technologies.com';
  const subject = 'Skyfall / Substitution Request Generator — support request';
  const body = 'Describe what you were doing when the issue occurred:\n\n\nApp version: (see Settings)\nOS: ' +
    (navigator.platform || 'unknown') + '\n';
  window.api.openEmail({ to, subject, body });
}

/* ==========================================================================
   FEEDBACK MODAL
   In-app feedback form. Posts to /api/feedback (handled by main.js IPC).
   Reed gets an email per submission; user gets an optional reply via
   the email field.
   ========================================================================== */
let feedbackCategory = 'other';
let feedbackSending = false;

function openFeedback() {
  const modal = document.getElementById('feedback-modal');
  if (!modal) return;
  // Reset state on every open — don't carry typed text across opens.
  document.getElementById('feedback-body').value = '';
  document.getElementById('feedback-email').value = '';
  feedbackCategory = 'other';
  document.querySelectorAll('.feedback-cat').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.cat === 'other');
  });
  const status = document.getElementById('feedback-status');
  status.classList.add('hidden');
  status.textContent = '';
  status.className = 'feedback-status hidden';
  modal.classList.remove('hidden');
  setTimeout(() => document.getElementById('feedback-body').focus(), 50);
}

function closeFeedback() {
  if (feedbackSending) return;  // don't yank the modal mid-send
  const modal = document.getElementById('feedback-modal');
  if (modal) modal.classList.add('hidden');
}

document.getElementById('feedback-close')?.addEventListener('click', closeFeedback);
document.getElementById('feedback-cancel')?.addEventListener('click', closeFeedback);

// Close on backdrop click (but not when clicking inside the modal box).
document.getElementById('feedback-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'feedback-modal') closeFeedback();
});

// Category buttons — one is always active. Visual state mirrors feedbackCategory.
document.querySelectorAll('.feedback-cat').forEach((btn) => {
  btn.addEventListener('click', () => {
    feedbackCategory = btn.dataset.cat || 'other';
    document.querySelectorAll('.feedback-cat').forEach((b) => {
      b.classList.toggle('is-active', b === btn);
    });
  });
});

document.getElementById('feedback-send')?.addEventListener('click', async () => {
  if (feedbackSending) return;
  const sendBtn = document.getElementById('feedback-send');
  const status = document.getElementById('feedback-status');
  const body = (document.getElementById('feedback-body').value || '').trim();
  const email = (document.getElementById('feedback-email').value || '').trim();

  status.classList.remove('hidden');
  if (!body) {
    status.className = 'feedback-status err';
    status.textContent = 'Please type a message before sending.';
    return;
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    status.className = 'feedback-status err';
    status.textContent = 'That email looks off — leave it blank or fix it.';
    return;
  }

  feedbackSending = true;
  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending…';
  status.className = 'feedback-status';
  status.textContent = '';

  try {
    const res = await window.api.sendFeedback({
      category: feedbackCategory,
      body,
      user_email: email || undefined,
    });
    if (res && res.success) {
      status.className = 'feedback-status ok';
      status.textContent = 'Sent! Reed gets a copy in his inbox right now. Thanks for taking the time.';
      // Clear the body so accidentally sending the same message twice is harder.
      document.getElementById('feedback-body').value = '';
      // Auto-close after a beat so the user gets feedback the send worked.
      setTimeout(() => { closeFeedback(); }, 1800);
    } else {
      status.className = 'feedback-status err';
      status.textContent = (res && res.error) || 'Couldn’t send right now. Try again in a moment.';
    }
  } catch (err) {
    status.className = 'feedback-status err';
    status.textContent = (err && err.message) || 'Couldn’t send right now. Try again in a moment.';
  } finally {
    feedbackSending = false;
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send feedback';
  }
});

/* ==========================================================================
   SETTINGS
   ========================================================================== */
async function openSettings() {
  showSection('settings');
  try {
    const info = await window.api.getAppInfo();
    if (info?.success) {
      document.getElementById('settings-version').textContent   = info.version || '—';
      document.getElementById('settings-version-meta').textContent =
        `Electron ${info.electron}, Node ${info.node}, ${info.platform}`;
      document.getElementById('settings-data-path').textContent = info.dataDir || '—';
      document.getElementById('settings-logs-path').textContent = info.logsDir || '—';
      // Customer ID surfaced from main.js's getAppInfo. New field — falls
      // back to "Not configured" for builds that pre-date this change.
      const cid = document.getElementById('settings-customer-id');
      if (cid) cid.textContent = info.customerId || 'Not configured';

      document.getElementById('settings-reveal-data').onclick = () =>
        window.api.revealInFinder(info.dataDir);
      document.getElementById('settings-reveal-logs').onclick = () =>
        window.api.revealInFinder(info.logsDir);
    }
  } catch (err) {
    /* ignore — leave the dashes in place */
  }

  // "Send feedback" CTA — same modal the sidebar Send-feedback nav opens.
  const feedbackBtn = document.getElementById('settings-feedback');
  if (feedbackBtn) {
    feedbackBtn.onclick = () => {
      if (typeof openFeedback === 'function') openFeedback();
    };
  }

  // "Check for updates now" — fires the autoUpdater check immediately rather
  // than waiting for the once-per-hour interval. Shows status inline so the
  // user gets feedback their click did something.
  const checkBtn = document.getElementById('settings-check-updates');
  const updateStatus = document.getElementById('settings-update-status');
  if (checkBtn && window.api && window.api.checkForUpdates) {
    checkBtn.onclick = async () => {
      checkBtn.disabled = true;
      checkBtn.textContent = 'Checking…';
      if (updateStatus) updateStatus.textContent = '';
      try {
        const result = await window.api.checkForUpdates();
        if (updateStatus) {
          if (result && result.success) {
            updateStatus.textContent = result.message || 'Checked.';
            updateStatus.style.color = '';
          } else {
            updateStatus.textContent = (result && result.error) || 'Check failed.';
            updateStatus.style.color = 'var(--err, #b91c1c)';
          }
        }
      } catch (err) {
        if (updateStatus) {
          updateStatus.textContent = (err && err.message) || 'Check failed.';
          updateStatus.style.color = 'var(--err, #b91c1c)';
        }
      } finally {
        checkBtn.disabled = false;
        checkBtn.textContent = 'Check for updates';
      }
    };
  }

  document.getElementById('settings-clear-history').onclick = async () => {
    if (!confirm('Delete all saved sessions and drafts? This cannot be undone.')) return;
    const r = await window.api.clearHistory();
    if (r?.success) {
      sessionCache = [];
      draftsCache  = [];
      updateDraftsBadge(0);
      renderSessionHistory();
      alert('History cleared.');
    }
  };

  // Note: BYO Anthropic-key UI deliberately not exposed. Strategy is that
  // we eat the AI cost as a business expense (priced into the subscription),
  // not pass it through to enterprise customers via their own Anthropic
  // account. The IPC handlers in main.js (`get-api-key-status`,
  // `save-user-api-key`, `clear-user-api-key`) and the priority-order
  // resolution in `services/claude.js` are still wired in case we want to
  // expose this later, but they're dormant.
}

/* ==========================================================================
   AI QUERY BAR — Haiku-powered Q&A about the current analysis
   ========================================================================== */
const queryBarEl       = document.getElementById('query-bar');
const queryToggleEl    = document.getElementById('query-toggle');
const queryBodyEl      = document.getElementById('query-body');
const queryChevronEl   = document.getElementById('query-chevron');
const queryInputEl     = document.getElementById('query-input');
const querySubmitEl    = document.getElementById('query-submit');
const queryThreadEl    = document.getElementById('query-thread');
const querySuggestEls  = document.querySelectorAll('.query-suggestion');

const queryHistory = [];

function showQueryBar(show) {
  if (!queryBarEl) return;
  queryBarEl.style.display = show ? '' : 'none';
}

// Reveal the query bar whenever the results section is visible.
// (MutationObserver on the section's class list — no need to intercept
// the existing renderResults / showSection functions.)
const resultsObserver = new MutationObserver(() => {
  const rs = document.getElementById('results-section');
  if (!rs) return;
  showQueryBar(!rs.classList.contains('hidden'));
});
if (resultsSection) {
  resultsObserver.observe(resultsSection, { attributes: true, attributeFilter: ['class'] });
}

// Collapse/expand
queryToggleEl?.addEventListener('click', () => {
  const collapsed = queryBarEl.classList.toggle('is-collapsed');
  queryToggleEl.setAttribute('aria-expanded', String(!collapsed));
});
queryToggleEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    queryToggleEl.click();
  }
});

// Suggestion chip clicks populate the input and submit
querySuggestEls.forEach((el) => {
  el.addEventListener('click', () => {
    if (queryInputEl) queryInputEl.value = el.dataset.q || el.textContent;
    runQuery();
  });
});

// Enter to submit
queryInputEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runQuery(); }
});
querySubmitEl?.addEventListener('click', runQuery);

// Global keyboard shortcuts
document.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;

  // Cmd/Ctrl+K → focus the query bar (expands if collapsed) — only when
  // the results screen is visible (otherwise there's no analysis to query).
  if (meta && (e.key === 'k' || e.key === 'K')) {
    const rs = document.getElementById('results-section');
    if (rs && !rs.classList.contains('hidden') && queryInputEl) {
      e.preventDefault();
      if (queryBarEl?.classList.contains('is-collapsed')) {
        queryToggleEl?.click();
      }
      queryInputEl.focus();
      queryInputEl.select();
    }
  }

  // Escape inside a library/settings/help section returns to the last
  // "working" surface — results if there's an active analysis, else upload.
  if (e.key === 'Escape') {
    const libSections = ['library-recent-section','library-catalog-section',
      'library-drafts-section','help-guide-section','settings-section'];
    const inLibrary = libSections.some((id) => {
      const el = document.getElementById(id);
      return el && !el.classList.contains('hidden');
    });
    if (inLibrary) {
      if (currentMatchedData && lastExtracted) showSection('results');
      else showSection('upload');
    }
  }
});

async function runQuery() {
  if (!queryInputEl || !queryThreadEl) return;
  const question = queryInputEl.value.trim();
  if (!question) return;
  if (!lastExtracted || !currentMatchedData) {
    appendQueryMessage('assistant',
      'I need an analysis to answer questions. Run an analysis first, then ask away.');
    return;
  }

  // Append user message
  appendQueryMessage('user', question);
  queryInputEl.value = '';
  querySubmitEl.disabled = true;

  // Typing indicator
  const typingId = 'typing-' + Date.now();
  appendQueryMessage('assistant', '<span class="query-typing"><span></span><span></span><span></span></span>', typingId);

  try {
    const res = await window.api.askQuestion(question, {
      extracted: lastExtracted,
      matched:   currentMatchedData,
      history:   queryHistory.slice(-6),
    });
    removeQueryMessage(typingId);
    if (res?.success && res.answer) {
      appendQueryMessage('assistant', res.answer);
      queryHistory.push({ role: 'user',      content: question });
      queryHistory.push({ role: 'assistant', content: res.answer });
    } else {
      appendQueryMessage('assistant', res?.error || 'Something went wrong.');
    }
  } catch (err) {
    removeQueryMessage(typingId);
    appendQueryMessage('assistant', 'Error: ' + (err?.message || err));
  } finally {
    querySubmitEl.disabled = false;
    queryInputEl.focus();
  }
}

function appendQueryMessage(role, content, id = null) {
  if (!queryThreadEl) return;
  const div = document.createElement('div');
  div.className = 'query-msg query-msg-' + role;
  if (id) div.dataset.msgId = id;
  const text = typeof content === 'string' ? content : String(content);
  // Safe rendering — typing indicator is passed as trusted HTML, answers escape
  if (role === 'assistant' && /<span class="query-typing"/.test(text)) {
    div.innerHTML = text;
  } else {
    div.innerHTML = escape(text).replace(/\n/g, '<br>');
  }
  queryThreadEl.appendChild(div);
  queryThreadEl.scrollTop = queryThreadEl.scrollHeight;
}

function removeQueryMessage(id) {
  const el = queryThreadEl?.querySelector(`.query-msg[data-msg-id="${id}"]`);
  if (el) el.remove();
}

/* The "Save draft" button is injected into the preview toolbar inside
   renderSubstitutionRequest(), so it only appears after a request has
   actually been generated. That keeps the Step 3 form uncluttered and
   guarantees there's something worth saving. */

/* ==========================================================================
   "WHAT'S NEW" MODAL — shown once per version after auto-update completes
   ==========================================================================
   On every launch, compare app.getVersion() vs the version stored in
   localStorage.cipherLastSeenVersion. If they differ AND there's a stored
   value (i.e. not the very first launch on this machine), show the
   highlights for the current version. After the user dismisses, persist
   the new version so we don't show it again.

   The CHANGELOG object is the source of truth — bump it on every release.
   Keep highlights short, customer-facing, plain English. Avoid jargon.
*/

const CIPHER_CHANGELOG = {
  '1.4.0': {
    date: '2026-04-30',
    highlights: [
      'New: in-app feedback button (sidebar → Send feedback). Bugs, ideas, praise — straight to Reed.',
      'Better diagnostics under the hood (architecture + memory) so we can debug your reports faster.',
      'Telemetry pipeline live — your usage helps shape the next release.',
    ],
  },
  '1.3.0': {
    date: '2026-04-29',
    highlights: [
      'Fixed: product count now reads correctly from the Soprema catalog.',
      'New: usage telemetry so we know what features are working (or not).',
      'Smoother auto-update flow.',
    ],
  },
  '1.2.0': {
    date: '2026-04-28',
    highlights: [
      'New: one-click "Download full package" — cover letter + property comparison + all datasheets, merged into a single bookmarked PDF.',
      'Improved: substitution-request layout polish.',
    ],
  },
};

const LAST_SEEN_KEY = 'cipherLastSeenVersion';

async function maybeShowWhatsNew() {
  try {
    const info = await window.api.getAppInfo();
    if (!info || !info.success) return;
    const current = String(info.version || '').trim();
    if (!current) return;

    let lastSeen = null;
    try {
      lastSeen = localStorage.getItem(LAST_SEEN_KEY);
    } catch (_) { /* localStorage unavailable — bail */ return; }

    // First-ever launch on this machine: just record the version. Don't
    // surface "What's new" — there's no prior version for the user to be
    // upgrading from. Showing it on first install would feel weird.
    if (!lastSeen) {
      try { localStorage.setItem(LAST_SEEN_KEY, current); } catch (_) { /* */ }
      return;
    }

    if (lastSeen === current) return;

    // Different version since last launch — show the changelog for the
    // current version (if we have one bundled). If we don't have an entry
    // for this exact version, silently update lastSeen and skip.
    const entry = CIPHER_CHANGELOG[current];
    if (!entry) {
      try { localStorage.setItem(LAST_SEEN_KEY, current); } catch (_) { /* */ }
      return;
    }

    showWhatsNewModal(current, entry);

    // Persist immediately on display — if the user force-quits the app
    // before clicking "Got it", we still don't want to nag them on the
    // next launch.
    try { localStorage.setItem(LAST_SEEN_KEY, current); } catch (_) { /* */ }
  } catch (_) { /* fail silently — never block app launch on this */ }
}

function showWhatsNewModal(version, entry) {
  const modal = document.getElementById('whatsnew-modal');
  if (!modal) return;
  const title = document.getElementById('whatsnew-title');
  const meta = document.getElementById('whatsnew-meta');
  const list = document.getElementById('whatsnew-list');
  if (title) title.textContent = `What's new in Cipher v${version}`;
  if (meta) meta.textContent = entry.date ? `Released ${entry.date}` : '';
  if (list) {
    list.innerHTML = '';
    (entry.highlights || []).forEach((h) => {
      const li = document.createElement('li');
      li.textContent = h;
      list.appendChild(li);
    });
  }
  modal.classList.remove('hidden');
}

function closeWhatsNew() {
  const modal = document.getElementById('whatsnew-modal');
  if (modal) modal.classList.add('hidden');
}
document.getElementById('whatsnew-close')?.addEventListener('click', closeWhatsNew);
document.getElementById('whatsnew-ok')?.addEventListener('click', closeWhatsNew);
document.getElementById('whatsnew-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'whatsnew-modal') closeWhatsNew();
});

// Kick off on next tick so it lands after the splash dismissal handler has
// wired up. The splash overlay sits z-indexed above the rest of the app, so
// the modal stays hidden visually until the user clicks past the splash.
setTimeout(() => { maybeShowWhatsNew(); }, 0);

/* ==========================================================================
   FIRST-LAUNCH ONBOARDING
   ==========================================================================
   Shown exactly once per machine — keyed off localStorage.cipherOnboarded.
   Critical for cold-outreach prospects who open Cipher with zero context.
   The modal explains the four-step flow and links to the bundled sample spec
   if one is available (so prospects can demo without their own PDF on hand).

   Suppressed in two cases:
     1. User has already onboarded (localStorage flag set)
     2. We just showed the "What's new" modal (don't double-stack overlays)

   Mark as onboarded as soon as the modal opens, not on dismiss — if the user
   closes the app mid-onboarding they shouldn't see it again next launch.
*/
const ONBOARDED_KEY = 'cipherOnboarded';

async function maybeShowOnboarding() {
  try {
    let onboarded = null;
    try { onboarded = localStorage.getItem(ONBOARDED_KEY); } catch (_) { return; }
    if (onboarded === '1') return;

    // If the "What's new" modal is currently open, hold off — surfacing two
    // modals at once is a bad first impression. We'll mark onboarded so the
    // user doesn't see this on next launch either; first-impression hat is
    // already worn.
    const whatsNew = document.getElementById('whatsnew-modal');
    if (whatsNew && !whatsNew.classList.contains('hidden')) {
      try { localStorage.setItem(ONBOARDED_KEY, '1'); } catch (_) { /* */ }
      return;
    }

    const modal = document.getElementById('onboarding-modal');
    if (!modal) return;

    // Surface the sample-spec link inside the onboarding modal too if we
    // have one bundled. Either click path (modal link or upload-screen link)
    // ends up at setFile() + analyze, so behavior is identical.
    let sampleResult = null;
    try {
      if (window.api && window.api.getSampleSpec) {
        sampleResult = await window.api.getSampleSpec();
      }
    } catch (_) { /* fail silently */ }
    const sampleHint = document.getElementById('onboarding-sample-hint');
    const sampleBtn = document.getElementById('onboarding-try-sample');
    if (sampleHint && sampleResult && sampleResult.available) {
      sampleHint.style.display = '';
      if (sampleBtn) {
        sampleBtn.addEventListener('click', () => {
          closeOnboarding();
          if (typeof setFile === 'function') setFile(sampleResult.path);
          if (window.api && window.api.trackEvent) {
            window.api.trackEvent('sample_spec_loaded', { source: 'onboarding-modal' }).catch(() => {});
          }
          if (analyzeBtn && !analyzeBtn.disabled) analyzeBtn.click();
        });
      }
    } else if (sampleHint) {
      sampleHint.style.display = 'none';
    }

    modal.classList.remove('hidden');
    // Persist immediately on display so a force-quit doesn't replay the
    // modal next launch.
    try { localStorage.setItem(ONBOARDED_KEY, '1'); } catch (_) { /* */ }
  } catch (_) { /* never block first launch on this */ }
}

function closeOnboarding() {
  const modal = document.getElementById('onboarding-modal');
  if (modal) modal.classList.add('hidden');
}
document.getElementById('onboarding-skip')?.addEventListener('click', closeOnboarding);
document.getElementById('onboarding-start')?.addEventListener('click', closeOnboarding);
document.getElementById('onboarding-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'onboarding-modal') closeOnboarding();
});

// Kick onboarding slightly after What's-new so if both could fire, What's-new
// wins (the user has used the app before — that's a higher-value surface).
setTimeout(() => { maybeShowOnboarding(); }, 50);

// License-status banner — only surfaces when main has detected 3+ consecutive
// invalid responses from /api/license/check. Defensive UX, not a hard gate.
if (window.api && window.api.onLicenseStatus) {
  window.api.onLicenseStatus(({ valid }) => {
    if (valid === false) {
      const banner = document.getElementById('license-banner');
      if (banner) banner.classList.remove('hidden');
    }
  });
}