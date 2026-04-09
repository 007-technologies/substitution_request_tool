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

// State management
function showSection(id) {
  [uploadSection, loadingSection, errorSection, resultsSection].forEach(s => s.classList.add('hidden'));
  document.getElementById(`${id}-section`).classList.remove('hidden');
}

// File selection via native dialog
selectBtn.addEventListener('click', async () => {
  const path = await window.api.selectFile();
  if (path) setFile(path);
});

// Drag and drop
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file && file.path && file.name.toLowerCase().endsWith('.pdf')) {
    setFile(file.path);
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
  showSection('loading');

  const result = await window.api.analyze(selectedFilePath);

  if (result.success) {
    renderResults(result.data);
    showSection('results');
    // Step 3: reveal the substitution request panel
    showStep3(result.data.matched);
  } else {
    errorText.textContent = result.error || 'An unknown error occurred.';
    showSection('error');
  }
});

// Progress updates from main process
window.api.onProgress((message) => {
  progressText.textContent = message;
});

// Retry
retryBtn.addEventListener('click', () => {
  showSection('upload');
});

// New analysis
newBtn.addEventListener('click', () => {
  selectedFilePath = null;
  fileName.textContent = '';
  analyzeBtn.disabled = true;
  // Hide and reset Step 3
  const step3 = document.getElementById('step3');
  if (step3) step3.style.display = 'none';
  const preview = document.getElementById('subRequestPreview');
  if (preview) preview.style.display = 'none';
  currentMatchedData = null;
  showSection('upload');
});

// Export PDF
exportBtn.addEventListener('click', async () => {
  const result = await window.api.exportPDF();
  if (result.success) {
    // Brief visual feedback
    exportBtn.textContent = 'Exported!';
    setTimeout(() => { exportBtn.textContent = 'Export as PDF'; }, 2000);
  }
});

// Render results
function renderResults(data) {
  const { extracted, matched } = data;

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
    matched.matches.forEach((m) => {
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

      const card = document.createElement('div');
      card.className = 'match-card';
      card.innerHTML = `
        <div class="match-side">
          <h4>Specified Product</h4>
          <div class="manufacturer">${escape(spec.manufacturer || 'Unknown')}</div>
          <div class="product-name">${escape(spec.product_name || 'Unknown Product')}</div>
          <span class="product-type">${escape(spec.product_type || 'material')}</span>
          ${spec.specifications ? `<div class="specs">${escape(spec.specifications)}</div>` : ''}
          ${spec.section ? `<div class="specs">Section: ${escape(spec.section)}</div>` : ''}
        </div>
        <div class="match-arrow">&rarr;</div>
        <div class="match-side">
          <h4>Soprema Replacement</h4>
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
    matchesDiv.innerHTML = '<p>No product matches found.</p>';
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
      // Silently ignore update errors - don't bother the user
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

// ══════════════════════════════════════════════════════════════════════════════
// STEP 3 — Substitution Request Generator
// ══════════════════════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────────────────────
let currentMatchedData = null;   // set when Step 2 completes

// ── Show Step 3 panel after Step 2 finishes ───────────────────────────────────
function showStep3(matchedData) {
  currentMatchedData = matchedData;

  // Pre-fill date field with today
  const dateField = document.getElementById('subRequestDate');
  if (dateField) {
    dateField.value = new Date().toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric'
    });
  }

  const step3 = document.getElementById('step3');
  if (step3) {
    step3.style.display = 'block';
    step3.scrollIntoView({ behavior: 'smooth' });
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

  // Show status
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
  const filename    = `Substitution-Request-${specSection.replace(/[^a-z0-9]/gi, '-')}-${projectName.replace(/[^a-z0-9]/gi, '-')}.pdf`;

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
        <td>${escapeHtml(pt.attribute)}</td>
        <td>${escapeHtml(pt.specified)}</td>
        <td>${escapeHtml(pt.proposed)}</td>
        <td class="${pt.compliant ? 'compliant' : 'non-compliant'}">${pt.compliant ? '✓' : '✗'}</td>
      </tr>`).join('');

    const docsHTML = (sub.supportingDocuments || []).map(doc =>
      `<li><strong>${escapeHtml(doc.type)}:</strong> ${escapeHtml(doc.description)}</li>`
    ).join('');

    return `
      <div class="substitution-block">
        <h3 class="sub-heading">Proposed Substitution</h3>
        <div class="info-grid">
          <div><span class="label">Manufacturer:</span> ${escapeHtml(sub.manufacturer)}</div>
          <div><span class="label">Product Name:</span> ${escapeHtml(sub.productName)}</div>
          ${sub.productId ? `<div><span class="label">Product ID:</span> ${escapeHtml(sub.productId)}</div>` : ''}
          <div class="full-width"><span class="label">Description:</span> ${escapeHtml(sub.description)}</div>
          <div class="full-width"><span class="label">Reason for Substitution:</span> ${escapeHtml(sub.reason)}</div>
        </div>

        <h4>Point-by-Point Comparison</h4>
        <table class="comparison-table">
          <thead>
            <tr><th>Attribute</th><th>Specified</th><th>Proposed (Soprema)</th><th>Compliant</th></tr>
          </thead>
          <tbody>${compRows}</tbody>
        </table>

        <h4>Differences from Specified Product</h4>
        <p>${escapeHtml(sub.differences)}</p>

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
      <!-- Header -->
      <div class="form-header">
        <h1>${escapeHtml(data.formTitle || 'SUBSTITUTION REQUEST FORM')}</h1>
        <p class="phase-label">For Substitution Requests ${escapeHtml(data.biddingPhase || 'Prior to Bidding')}</p>
      </div>

      <!-- Project Info Table -->
      <table class="info-table">
        <tr><td class="info-label">Project</td><td>${escapeHtml(data.projectName)}</td></tr>
        <tr><td class="info-label">Spec Section</td><td>${escapeHtml(data.specSection)}</td></tr>
        <tr><td class="info-label">Addressed To</td><td>${escapeHtml(data.addressedTo)}</td></tr>
        <tr><td class="info-label">Submitted By</td><td>${escapeHtml(data.submittedBy)}</td></tr>
        <tr><td class="info-label">Date</td><td>${escapeHtml(data.date || '')}</td></tr>
      </table>

      <!-- Products Being Substituted -->
      <h3 class="section-heading">Products Being Substituted</h3>
      <ul class="specified-list">${specifiedHTML}</ul>

      <!-- Each Substitution -->
      ${subsHTML}

      <!-- Technical Narrative -->
      ${data.technicalNarrative ? `
      <div class="narrative-block">
        <h3 class="section-heading">Technical Narrative</h3>
        <p>${escapeHtml(data.technicalNarrative).replace(/\n\n/g, '</p><p>')}</p>
      </div>` : ''}

      <!-- Certification -->
      <div class="certification-block">
        <p class="certification-text">${escapeHtml(data.certificationStatement || '')}</p>
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
  .non-compliant{ color: red;   font-weight: bold; text-align: center; }
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
