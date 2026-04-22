let selectedFilePath = null;

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

// State management
function showSection(id) {
  [uploadSection, loadingSection, errorSection, resultsSection].forEach(s => s.classList.add('hidden'));
  document.getElementById(`${id}-section`).classList.remove('hidden');
}

// Inline loading — shows/hides the loading card within the upload section
function showInlineLoading(show) {
  const card    = document.getElementById('upload-loading-card');
  const zone    = document.getElementById('drop-zone');
  const btn     = document.getElementById('analyze-btn');
  if (show) {
    uploadSection.classList.remove('hidden');
    zone.classList.add('hidden');
    btn.classList.add('hidden');
    card.classList.remove('hidden');
  } else {
    card.classList.add('hidden');
    zone.classList.remove('hidden');
    btn.classList.remove('hidden');
  }
}

function setLoadingState(stateKey, overrideMessage = null) {
  const step = loadingSteps[stateKey];
  if (!step) return;

  currentLoadingState = stateKey;

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

function inferLoadingStateFromMessage(message = '') {
  const lower = message.toLowerCase();

  if (
    lower.includes('upload') ||
    lower.includes('reading file') ||
    lower.includes('preparing')
  ) {
    return 'uploading';
  }

  if (
    lower.includes('extract') ||
    lower.includes('scan') ||
    lower.includes('roofing text') ||
    lower.includes('parsing')
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

// Analyze
analyzeBtn.addEventListener('click', async () => {
  if (!selectedFilePath) return;

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
                &#128196; ${escape(d.name || d.filename || 'Datasheet')}
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

      const card = document.createElement('div');
      card.className = 'match-card';
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
          <span class="confidence confidence-${conf}">${conf}</span>
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
        <div class="empty-state-icon">&#128269;</div>
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

// ── Render the generated form as styled HTML ───────────────────────────────────
function renderSubstitutionRequest(data) {
  const container = document.getElementById('subRequestContent');
  if (!container) return;

  container.innerHTML = buildSubRequestHTML(data);

  const preview = document.getElementById('subRequestPreview');
  if (preview) {
    preview.style.display = 'block';
    preview.scrollIntoView({ behavior: 'smooth' });
  }
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

// ── HTML builder — generates the printable form ───────────────────────────────
function buildSubRequestHTML(data) {
  const subs = data.proposedSubstitutions || [];

  const subsHTML = subs.map(sub => {
    const compRows = (sub.comparisonPoints || []).map(pt => `
      <tr>
        <td contenteditable="true" class="ef">${escapeHtml(pt.attribute)}</td>
        <td contenteditable="true" class="ef">${escapeHtml(pt.specified)}</td>
        <td contenteditable="true" class="ef">${escapeHtml(pt.proposed)}</td>
        <td class="${pt.compliant ? 'compliant' : 'non-compliant'}">${pt.compliant ? '✓' : '✗'}</td>
      </tr>`).join('');

    const docsHTML = (sub.supportingDocuments || []).map(doc =>
      `<li><strong>${escapeHtml(doc.type)}:</strong> ${escapeHtml(doc.description)}</li>`
    ).join('');

    return `
      <div class="substitution-block">
        <h3 class="sub-heading">Proposed Substitution</h3>
        <div class="info-grid">
          <div><span class="label">Manufacturer:</span> <span contenteditable="true" class="ef">${escapeHtml(sub.manufacturer)}</span></div>
          <div><span class="label">Product Name:</span> <span contenteditable="true" class="ef">${escapeHtml(sub.productName)}</span></div>
          ${sub.productId ? `<div><span class="label">Product ID:</span> <span contenteditable="true" class="ef">${escapeHtml(sub.productId)}</span></div>` : ''}
          <div class="full-width"><span class="label">Description:</span> <span contenteditable="true" class="ef">${escapeHtml(sub.description)}</span></div>
          <div class="full-width"><span class="label">Reason for Substitution:</span> <span contenteditable="true" class="ef">${escapeHtml(sub.reason)}</span></div>
        </div>

        <h4>Point-by-Point Comparison</h4>
        <table class="comparison-table">
          <thead>
            <tr><th>Attribute</th><th>Specified</th><th>Proposed (Soprema)</th><th>Compliant</th></tr>
          </thead>
          <tbody>${compRows}</tbody>
        </table>

        <h4>Differences from Specified Product</h4>
        <p contenteditable="true" class="ef">${escapeHtml(sub.differences)}</p>

        ${sub.affectedDrawingsAndSpecs ? `
        <h4>Affected Drawings / Spec Sections</h4>
        <p>${escapeHtml(sub.affectedDrawingsAndSpecs)}</p>` : ''}

        <h4>Supporting Documentation</h4>
        <ul>${docsHTML}</ul>
      </div>`;
  }).join('');

  const specifiedHTML = (data.specifiedProducts || []).map(p =>
    `<li><strong>${escapeHtml(p.manufacturer)} — ${escapeHtml(p.productName)}:</strong> ${escapeHtml(p.description)}</li>`
  ).join('');

  return `
    <div class="sub-request-doc">
      <div class="form-header">
        <h1>${escapeHtml(data.formTitle || 'SUBSTITUTION REQUEST FORM')}</h1>
        <p class="phase-label">For Substitution Requests ${escapeHtml(data.biddingPhase || 'Prior to Bidding')}</p>
      </div>

      <table class="info-table">
        <tr><td class="info-label">Project</td><td contenteditable="true" class="ef">${escapeHtml(data.projectName)}</td></tr>
        <tr><td class="info-label">Spec Section</td><td contenteditable="true" class="ef">${escapeHtml(data.specSection)}</td></tr>
        <tr><td class="info-label">Addressed To</td><td contenteditable="true" class="ef">${escapeHtml(data.addressedTo)}</td></tr>
        <tr><td class="info-label">Submitted By</td><td contenteditable="true" class="ef">${escapeHtml(data.submittedBy)}</td></tr>
        <tr><td class="info-label">Date</td><td contenteditable="true" class="ef">${escapeHtml(data.date || '')}</td></tr>
      </table>

      <h3 class="section-heading">Products Being Substituted</h3>
      <ul class="specified-list" contenteditable="true" class="ef">${specifiedHTML}</ul>

      ${subsHTML}

      ${data.technicalNarrative ? `
      <div class="narrative-block">
        <h3 class="section-heading">Technical Narrative</h3>
        <p contenteditable="true" class="ef">${escapeHtml(data.technicalNarrative).replace(/\n\n/g, '</p><p>')}</p>
      </div>` : ''}

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
  h3 { font-size: 11pt; margin: 16px 0 6px; border-bottom: 1px solid #ccc; padding-bottom: 3px; }
  h4 { font-size: 10pt; margin: 12px 0 4px; color: #333; }
  p  { margin: 6px 0; line-height: 1.5; }
  .phase-label  { text-align: center; font-style: italic; color: #555; margin-bottom: 14px; }
  .section-heading { color: #c00; }
  .info-table   { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  .info-table td { border: 1px solid #ccc; padding: 5px 8px; font-size: 9.5pt; }
  .info-label   { font-weight: bold; width: 140px; background: #f5f5f5; }
  .sub-heading  { background: #003366; color: white; padding: 5px 8px; font-size: 10.5pt; margin: 16px 0 8px; }
  .info-grid    { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 20px; margin-bottom: 12px; font-size: 9.5pt; }
  .info-grid .full-width { grid-column: 1 / -1; }
  .label        { font-weight: bold; margin-right: 4px; }
  .comparison-table { width: 100%; border-collapse: collapse; font-size: 9pt; margin-bottom: 10px; }
  .comparison-table th { background: #003366; color: white; padding: 5px 7px; text-align: left; }
  .comparison-table td { border: 1px solid #ccc; padding: 4px 7px; vertical-align: top; }
  .comparison-table tr:nth-child(even) td { background: #f9f9f9; }
  .compliant    { color: green; font-weight: bold; text-align: center; }
  .non-compliant{ color: red; font-weight: bold; text-align: center; }
  ul            { margin: 6px 0 10px 18px; }
  li            { margin-bottom: 4px; line-height: 1.4; }
  .specified-list li { font-size: 9.5pt; }
  .narrative-block { margin-top: 16px; padding: 10px; background: #fafafa; border-left: 3px solid #003366; }
  .certification-block { margin-top: 24px; padding: 12px; border: 1px solid #ccc; background: #fffdf0; }
  .certification-text  { font-style: italic; font-size: 9pt; margin-bottom: 18px; }
  .signature-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 30px; }
  .sig-line span  { display: block; font-size: 8.5pt; color: #555; margin-bottom: 4px; }
  .line           { border-bottom: 1px solid #333; height: 28px; }
  @media print { body { padding: 0; } }
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