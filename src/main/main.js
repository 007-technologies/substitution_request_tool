const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

const configPath = app.isPackaged
  ? path.join(process.resourcesPath, 'config.json')
  : path.join(__dirname, '..', '..', 'config.json');
global.appConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const dataDir = app.isPackaged
  ? path.join(app.getPath('userData'), 'data')
  : path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
global.dataDir = dataDir;

const { fetchDocumentBuffer, fetchUrlBuffer } = require('../services/r2');
const { PDFDocument, PDFName, PDFHexString } = require('pdf-lib');

// Add a clickable PDF outline (bookmarks) to a merged PDFDocument. Each
// entry has a title and the 0-indexed page where its section begins.
// pdf-lib doesn't have a high-level outline API, so we build the dictionary
// tree manually using its low-level context.obj() / register() helpers.
// The result shows up in any PDF viewer's left-rail navigator.
function addPdfBookmarks(pdfDoc, sections) {
  if (!sections || sections.length === 0) return;
  const ctx = pdfDoc.context;

  // Allocate refs for the outlines root and each item up front so siblings
  // can reference each other (Prev/Next links).
  const outlineRef = ctx.register(ctx.obj({}));
  const itemRefs = sections.map(() => ctx.register(ctx.obj({})));

  sections.forEach((sec, i) => {
    const page = pdfDoc.getPage(sec.startPage);
    // Destination = [pageRef, /Fit] — fit-page view, jumps cleanly without
    // forcing a zoom level the architect didn't pick.
    const dest = ctx.obj([page.ref, PDFName.of('Fit')]);

    const itemFields = {
      Title: PDFHexString.fromText(sec.title),
      Parent: outlineRef,
      Dest: dest,
    };
    if (i > 0) itemFields.Prev = itemRefs[i - 1];
    if (i < sections.length - 1) itemFields.Next = itemRefs[i + 1];

    ctx.assign(itemRefs[i], ctx.obj(itemFields));
  });

  ctx.assign(outlineRef, ctx.obj({
    Type: PDFName.of('Outlines'),
    First: itemRefs[0],
    Last: itemRefs[itemRefs.length - 1],
    Count: sections.length,
  }));

  pdfDoc.catalog.set(PDFName.of('Outlines'), outlineRef);
}
// FIX: added getCondensedCatalog — required by the get-catalog-products handler
const { loadCatalog, getFilteredCatalog, getDocumentsList, getCondensedCatalog, getDocumentUrlByFilename } = require('../services/catalog');
const { extractProducts, matchProducts, generateSubstitutionRequest, askQuestion } = require('../services/claude');
const { extractRoofingText, extractRoofingPages } = require('../services/pdfExtractor');
const { track, trackQuit, trackError } = require('../services/telemetry');

// ── Process-level error tracking ──────────────────────────────────────────────
// Catches anything that bubbles up uncaught — IPC handler errors are caught by
// Electron and sent back to the renderer (so don't reach here), but anything
// in the main process outside an IPC context will be captured.
process.on('uncaughtException', (err) => {
  trackError('uncaughtException', err).catch(() => {});
});
process.on('unhandledRejection', (reason) => {
  trackError('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason))).catch(() => {});
});

// ── App quit telemetry ────────────────────────────────────────────────────────
// Race the trackQuit call with a 1.5s timeout so the app never hangs at quit.
// Worst case we lose the quit event when the network is slow; better than
// blocking the user.
let isQuittingTracked = false;
app.on('before-quit', async (e) => {
  if (isQuittingTracked) return;
  isQuittingTracked = true;
  e.preventDefault();
  try {
    await Promise.race([
      trackQuit(),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch (_) { /* swallow */ }
  app.quit();
});

// ── Friendly error messages ───────────────────────────────────────────────────
// Maps SDK / Node / Electron error shapes to actionable customer-facing
// strings. Catch-all returns the raw message so we never swallow useful info
// — but every common failure mode the customer can actually act on should
// have a curated message above the fallback.
//
// Goals:
//   - Tell the user what's wrong, not just that something is wrong
//   - Suggest a concrete next step (retry, check config, switch network, etc.)
//   - Never leak stack traces, file paths, or API keys to the renderer
//   - Keep messages calm — don't apologize repeatedly, don't shout
function friendlyError(err) {
  const msg = err?.message || String(err);
  const status = err?.status || (err?.response && err.response.status);

  // ── Anthropic / API errors ───────────────────────────────────────────────
  if (status === 429 || /rate.?limit|quota.exceeded/i.test(msg))
    return 'Too many requests — wait a minute, then try again. (If this keeps happening, your Anthropic plan may be at its limit.)';
  if (status === 401 || /invalid.api.key|authentication|unauthorized/i.test(msg))
    return 'Cipher’s Anthropic API key was rejected. Reach out to support@007technologies.com — your build needs a refreshed key.';
  if (status === 402 || /credit.balance|insufficient.credit/i.test(msg))
    return 'Anthropic credit balance is too low to run this analysis. Reach out to support@007technologies.com.';
  if (status >= 500 && status < 600)
    return 'Anthropic is having a hiccup on their end (' + status + '). Try again in a couple of minutes.';
  if (/Failed to parse Claude response|invalid.JSON|unexpected.token/i.test(msg))
    return 'Got an unexpected response from the AI. Try the analysis again — usually transient.';

  // ── PDF read / extraction errors ─────────────────────────────────────────
  if (/Could not read PDF|InvalidPDF|not a PDF|PDFInvalidError/i.test(msg))
    return 'This file doesn’t look like a valid PDF. Re-export from your spec source and try again.';
  if (/No readable text|scanned image|empty content/i.test(msg))
    return 'This PDF has no readable text — it looks scanned. Export a text-based PDF (most spec tools have a "searchable" option).';
  if (/Encrypted|password|protected/i.test(msg))
    return 'This PDF is password-protected. Remove the password and try again.';
  if (/file too large|MAX_BUFFER_LENGTH|Cannot create a string longer/i.test(msg))
    return 'This PDF is too big for Cipher to process. If it’s a full project manual, try uploading just the roofing section (Division 07).';

  // ── Network errors (R2, Anthropic, telemetry) ────────────────────────────
  if (/R2|fetchMetadata|NoSuchKey|AccessDenied|InvalidAccessKey/i.test(msg))
    return 'Couldn’t load the Soprema product catalog. Check your internet connection — if it persists, reach out to support@007technologies.com.';
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch.failed|network.error/i.test(msg))
    return 'Couldn’t reach the network. Check your internet connection and try again.';
  if (/abort|timeout/i.test(msg) && /fetch|request/i.test(msg))
    return 'The request timed out. Check your internet, then retry.';

  // ── PDF assembly / output errors ─────────────────────────────────────────
  if (/EACCES|EPERM|permission denied/i.test(msg))
    return 'Cipher couldn’t write to that location — pick a different folder or close the file if it’s open.';
  if (/ENOSPC|no space left/i.test(msg))
    return 'Your disk is full. Free up some space and try again.';
  if (/EBUSY|locked/i.test(msg))
    return 'That file is open in another app. Close it and try again.';
  if (/PDFLib|merge.*failed|bookmark/i.test(msg))
    return 'Cipher hit a snag assembling the PDF bundle. Try again — and if it persists, send feedback (sidebar → Send feedback) with what spec you were working on.';

  // Catch-all: pass through the raw message but trim it so the renderer
  // doesn't show a multi-line stack-tracey blob in a small alert.
  const trimmed = msg.split('\n')[0].slice(0, 240);
  return trimmed || 'Something went wrong. Try again, and send feedback if it keeps happening.';
}

let mainWindow;

// ── Single-window app shell ────────────────────────────────────────────────────
// Previously opened two BrowserWindows (splash + main). Now one window;
// the splash is an HTML overlay inside index.html that fades out when ready.
function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    show: true,
    backgroundColor: '#9F9D97',   // smokey grey — avoids white flash before splash paints
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Substitution Request Generator',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    try {
      app.dock.setIcon(path.join(__dirname, '..', '..', 'assets', 'icon.png'));
    } catch (e) { /* icon not found, use default */ }
  }

  createWindow();

  // Telemetry: app launched
  track('app_launched');

  // License validation (defensive — never blocks the app, just surfaces a
  // visible warning after repeated invalid responses). See validateLicense().
  // Fire-and-forget so launch isn't gated on network availability.
  validateLicense().catch(() => { /* fail silently */ });

  if (app.isPackaged) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => sendUpdate('checking'));
    autoUpdater.on('update-available', (info) => sendUpdate('available', info.version));
    autoUpdater.on('update-not-available', () => sendUpdate('not-available'));
    autoUpdater.on('download-progress', (p) => sendUpdate('downloading', Math.round(p.percent)));
    autoUpdater.on('update-downloaded', (info) => sendUpdate('downloaded', info.version));
    autoUpdater.on('error', (err) => sendUpdate('error', err.message));

    autoUpdater.checkForUpdates();
  }
});

app.on('window-all-closed', () => app.quit());

function sendProgress(msg) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('progress', msg);
  }
}

function sendUpdate(status, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', { status, data });
  }
}

// ── License validation ───────────────────────────────────────────────────────
// Calls /api/license/check with the bundled CUSTOMER_ID; counts consecutive
// invalid responses in a small JSON file under userData. After 3 consecutive
// invalid responses (across launches), emits a 'license-status' event the
// renderer surfaces as a banner.
//
// Design intent:
//   - Defensive, not punitive. Real customers must never be blocked by this
//     even on a server outage. The cap-at-3-invalid threshold ensures
//     transient false-negatives don't shake out as warnings.
//   - Reversible. Reed adds a customer to LICENSE_ALLOWLIST → next launch
//     resets the counter and the banner clears.
//   - Graceful with offline. Network errors do NOT count as invalid — only
//     a definitive { valid: false } from the server does.
//   - Permissive when server allowlist isn't configured. Server returns
//     valid: true so a misconfig on Reed's side doesn't lock out customers.
const LICENSE_STATE_FILE = 'license-state.json';
const LICENSE_INVALID_THRESHOLD = 3;

function readLicenseState() {
  try {
    const p = path.join(global.dataDir || app.getPath('userData'), LICENSE_STATE_FILE);
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  } catch (_) { /* ignore */ }
  return { invalidStreak: 0, lastCheckedTs: null, lastResult: null };
}
function writeLicenseState(state) {
  try {
    const dir = global.dataDir || app.getPath('userData');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, LICENSE_STATE_FILE),
      JSON.stringify(state, null, 2),
      'utf-8'
    );
  } catch (_) { /* non-fatal */ }
}

async function validateLicense() {
  const cfg = global.appConfig || {};
  const endpoint = cfg.TELEMETRY_ENDPOINT;
  const key = cfg.TELEMETRY_KEY;
  const customerId = cfg.CUSTOMER_ID;

  // No telemetry config = dev build = skip license validation entirely.
  if (!endpoint || !key || !customerId) return;

  // Derive the license endpoint by swapping /telemetry → /license/check —
  // same domain, no new config field needed.
  const licenseEndpoint = endpoint.replace(/\/telemetry\/?$/, '/license/check');

  const state = readLicenseState();

  let result = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(licenseEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telemetry-Key': key,
        },
        body: JSON.stringify({ customer_id: customerId, product: 'skyfall' }),
        signal: ctrl.signal,
      });
      if (res.ok) {
        result = await res.json();
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (_) {
    // Network failure — DO NOT increment invalidStreak. The customer might be
    // offline. Last cached result still applies.
    return;
  }

  // No definitive answer — keep state as-is.
  if (!result || typeof result.valid !== 'boolean') return;

  if (result.valid) {
    // Server affirms — reset streak so a single transient failure doesn't
    // accumulate over time.
    state.invalidStreak = 0;
  } else {
    state.invalidStreak = (state.invalidStreak || 0) + 1;
  }
  state.lastCheckedTs = new Date().toISOString();
  state.lastResult = result;
  writeLicenseState(state);

  // Surface the banner to the renderer once we've crossed the threshold.
  // The renderer keeps it visible until the streak resets (i.e. a future
  // launch with a valid response).
  if (state.invalidStreak >= LICENSE_INVALID_THRESHOLD) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('license-status', {
        valid: false,
        customer_id: customerId,
        streak: state.invalidStreak,
      });
    }
  }
}

ipcMain.handle('install-update', () => autoUpdater.quitAndInstall());

ipcMain.handle('select-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
    properties: ['openFile'],
  });

  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('analyze', async (event, filePath) => {
  try {
    // Step 1 of ~4. Real numbers in the message let the user see motion
    // even before any AI work has happened — anchors the wait.
    sendProgress('Reading specification…');
    track('spec_uploaded', { fileName: path.basename(filePath || '') });

    const pdfBuffer = fs.readFileSync(filePath);
    const fileSizeMb = Math.max(0.1, +(pdfBuffer.length / 1024 / 1024).toFixed(1));
    sendProgress('Reading specification… ' + fileSizeMb + ' MB');

    const pages = await extractRoofingPages(pdfBuffer);
    const pageCount = (pages && pages.length) || 0;
    sendProgress('Found ' + pageCount + ' roofing-related ' + (pageCount === 1 ? 'page' : 'pages') + '.');

    sendProgress('Loading the Soprema product catalog…');
    await loadCatalog();
    // Surface catalog size so the user feels how much we just pulled in.
    try {
      const catalogSize = (typeof getDocumentsList === 'function' ? (getDocumentsList() || []).length : 0);
      if (catalogSize) sendProgress('Catalog loaded — ' + catalogSize + ' Soprema documents available.');
    } catch (_) { /* non-fatal */ }

    sendProgress('Analyzing the specification with Claude…');
    const extracted = await extractProducts(pages, sendProgress);
    const extractedCount = ((extracted && extracted.products) || []).length;
    sendProgress('Found ' + extractedCount + ' product ' + (extractedCount === 1 ? 'reference' : 'references') + ' in the spec.');

    const productTypes = (extracted.products || [])
      .map((p) => p.product_type)
      .filter(Boolean);

    const filteredCatalog = getFilteredCatalog(productTypes);
    const documentsList = getDocumentsList();
    sendProgress('Matching against ' + filteredCatalog.length + ' candidate Soprema ' +
      (filteredCatalog.length === 1 ? 'product' : 'products') + '…');

    // Strip citation data before sending to Step 2 — citations are only needed
    // in the UI and add significant token overhead that matchProducts doesn't use.
    const extractedForMatching = {
      ...extracted,
      sourcePages: undefined,
      products: (extracted.products || []).map(({ citations, ...rest }) => rest),
    };

    const matched = await matchProducts(extractedForMatching, filteredCatalog, documentsList, sendProgress);

    const matchCount = ((matched && matched.matches) || []).length;
    sendProgress('Matched ' + matchCount + ' Soprema ' +
      (matchCount === 1 ? 'product' : 'products') + ' to the spec.');
    sendProgress('Analysis complete!');

    return {
      success: true,
      data: { extracted, matched },
    };
  } catch (err) {
    console.error('Analysis error:', err);
    trackError('analyze', err).catch(() => {});
    return { success: false, error: friendlyError(err) };
  }
});

ipcMain.handle('download-datasheet', async (event, r2Key, filename) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: filename || 'datasheet.pdf',
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
    });

    if (result.canceled) return { success: false };

    const buffer = await fetchDocumentBuffer(r2Key);
    fs.writeFileSync(result.filePath, buffer);

    return { success: true, path: result.filePath };
  } catch (err) {
    trackError('download-datasheet', err).catch(() => {});
    return { success: false, error: friendlyError(err) };
  }
});

ipcMain.handle('export-pdf', async () => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: 'substitution-report.pdf',
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
    });

    if (result.canceled) return { success: false };

    const pdfData = await mainWindow.webContents.printToPDF({
      printBackground: true,
      landscape: false,
      marginType: 0,
    });

    fs.writeFileSync(result.filePath, pdfData);

    return { success: true, path: result.filePath };
  } catch (err) {
    trackError('export-pdf', err).catch(() => {});
    return { success: false, error: friendlyError(err) };
  }
});

ipcMain.handle('generate-sub-request', async (event, matchedData, projectInfo) => {
  try {
    const formData = await generateSubstitutionRequest(matchedData, projectInfo, sendProgress);
    track('subrequest_generated', {
      productCount: ((matchedData && matchedData.matches) || []).length,
    });
    return { success: true, data: formData };
  } catch (err) {
    trackError('generate-sub-request', err).catch(() => {});
    return { success: false, error: friendlyError(err) };
  }
});

ipcMain.handle('export-sub-request-pdf', async (event, htmlContent, filename) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: filename || 'substitution-request.pdf',
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
    });

    if (result.canceled) return { success: false };

    const printWin = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    await printWin.loadURL(
      'data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent)
    );

    const pdfData = await printWin.webContents.printToPDF({
      printBackground: true,
      pageSize: 'Letter',
      margins: {
        marginType: 'custom',
        top: 0.5,
        bottom: 0.5,
        left: 0.5,
        right: 0.5,
      },
    });

    printWin.destroy();
    fs.writeFileSync(result.filePath, pdfData);

    return { success: true, filePath: result.filePath };
  } catch (err) {
    trackError('export-sub-request-pdf', err).catch(() => {});
    return { success: false, error: friendlyError(err) };
  }
});

// Helper: render an HTML string to a PDF buffer using a hidden BrowserWindow.
// Used by both export-sub-request-pdf (above) and export-bundle-pdf (below).
// Same printToPDF settings as the existing single-document export so the
// bundled output looks identical to a standalone export.
async function renderHtmlToPdfBuffer(htmlContent) {
  const printWin = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  try {
    await printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent));
    const pdfData = await printWin.webContents.printToPDF({
      printBackground: true,
      pageSize: 'Letter',
      margins: { marginType: 'custom', top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
    });
    return pdfData;
  } finally {
    printWin.destroy();
  }
}

// ── IPC: bundle export ────────────────────────────────────────────────────────
// Generates a single PDF containing:
//   1. Cover letter (rendered from HTML)
//   2. Substitution request form (rendered from HTML)
//   3. Soprema product datasheets (fetched from R2 by r2Key)
// All merged in order via pdf-lib. This is the "Download Full Submission
// Package" flow — turns Davis's hour of manual PDF assembly into one click.
ipcMain.handle('export-bundle-pdf', async (event, payload) => {
  const { coverLetterHTML, subRequestHTML, datasheets, filename } = payload || {};
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: filename || 'submission-package.pdf',
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
    });
    if (result.canceled) return { success: false };

    // Step 1+2: render cover letter and sub-request HTML to PDF buffers.
    // These come from the renderer's existing buildCoverLetterHTML and
    // buildPrintableHTML functions — main process just paginates them.
    const coverBuffer = coverLetterHTML ? await renderHtmlToPdfBuffer(coverLetterHTML) : null;
    const subRequestBuffer = subRequestHTML ? await renderHtmlToPdfBuffer(subRequestHTML) : null;

    // Step 3: fetch each Soprema datasheet. PDS files don't actually live
    // in R2 — they're hosted on Soprema's CDN at my.assets-library.com.
    // We resolve the filename from the matched data → real URL via
    // getDocumentUrlByFilename, then fetch via HTTPS. R2 path kept as a
    // fallback for any genuinely R2-hosted document (SDS, install guides
    // some of which DO live in R2).
    const datasheetBuffers = [];
    const fetchFailures = [];
    for (const ds of datasheets || []) {
      if (!ds) continue;
      const filename = ds.filename || (ds.r2Key && ds.r2Key.split('/').pop());
      let buf = null;
      let lastError = null;

      // Primary: resolve filename → URL on my.assets-library.com → fetch
      const url = ds.url || (filename && getDocumentUrlByFilename(filename));
      if (url) {
        try {
          buf = await fetchUrlBuffer(url);
        } catch (err) {
          lastError = err;
          console.warn('[bundle] URL fetch failed for ' + filename + ':', err.message);
        }
      }

      // Fallback: try R2 in case the doc is genuinely an R2 object
      if (!buf && ds.r2Key) {
        try {
          buf = await fetchDocumentBuffer(ds.r2Key);
        } catch (err) {
          lastError = err;
          console.warn('[bundle] R2 fallback failed for ' + ds.r2Key + ':', err.message);
        }
      }

      if (buf) {
        datasheetBuffers.push({ name: filename || 'datasheet.pdf', buffer: buf });
      } else {
        fetchFailures.push(filename || ds.r2Key || 'unknown');
      }
    }

    // Step 4: merge all PDFs in order. pdf-lib's copyPages preserves the
    // source PDF formatting (text, images, vector graphics) — Soprema PDSes
    // come through with their original layout intact. Track each section's
    // start page so we can write a clickable PDF outline at the end.
    const merged = await PDFDocument.create();
    const sources = [];
    if (coverBuffer)      sources.push({ name: 'Cover Letter',         buffer: coverBuffer });
    if (subRequestBuffer) sources.push({ name: 'Substitution Request', buffer: subRequestBuffer });
    // Datasheet bookmark titles: turn "PDS-SOPRA-ISO.pdf" into "SOPRA ISO".
    datasheetBuffers.forEach((d) => {
      const cleanTitle = String(d.name || 'Datasheet')
        .replace(/^PDS[\s-]*/i, '')   // drop "PDS-" prefix
        .replace(/\.pdf$/i, '')       // drop extension
        .replace(/[-_]+/g, ' ')       // hyphens/underscores → spaces
        .replace(/\s+/g, ' ')
        .trim();
      sources.push({ name: cleanTitle || 'Datasheet', buffer: d.buffer });
    });

    const sections = []; // { title, startPage } per successful merge
    const mergeFailures = [];
    let cursor = 0;
    for (const { name, buffer } of sources) {
      try {
        const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
        const pages = await merged.copyPages(src, src.getPageIndices());
        if (pages.length === 0) continue;
        sections.push({ title: name, startPage: cursor });
        pages.forEach((p) => merged.addPage(p));
        cursor += pages.length;
      } catch (err) {
        console.warn('[bundle] Failed to merge ' + name + ':', err.message);
        mergeFailures.push(name);
      }
    }

    if (merged.getPageCount() === 0) {
      return { success: false, error: 'Bundle is empty — no documents could be merged.' };
    }

    // Step 5: add bookmarks/outline so the architect can jump directly to
    // any section in the merged PDF (Cover Letter, Substitution Request,
    // each individual datasheet).
    try {
      addPdfBookmarks(merged, sections);
    } catch (err) {
      console.warn('[bundle] Bookmark generation failed (non-fatal):', err.message);
    }

    const mergedBytes = await merged.save();
    fs.writeFileSync(result.filePath, mergedBytes);

    track('bundle_exported', {
      pageCount: merged.getPageCount(),
      datasheetCount: datasheetBuffers.length,
      fetchFailures: fetchFailures.length,
      mergeFailures: mergeFailures.length,
    });

    return {
      success: true,
      filePath: result.filePath,
      pageCount: merged.getPageCount(),
      datasheetCount: datasheetBuffers.length,
      fetchFailures,
      mergeFailures,
    };
  } catch (err) {
    trackError('export-bundle-pdf', err).catch(() => {});
    return { success: false, error: friendlyError(err) };
  }
});

// ── IPC: session history ──────────────────────────────────────────────────────
ipcMain.handle('save-session', async (event, sessionData) => {
  try {
    const p = path.join(global.dataDir, 'sessions.json');
    let sessions = [];
    if (fs.existsSync(p)) sessions = JSON.parse(fs.readFileSync(p, 'utf-8'));
    sessions.unshift(sessionData);
    sessions = sessions.slice(0, 15);
    fs.writeFileSync(p, JSON.stringify(sessions));
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('load-sessions', async () => {
  try {
    const p = path.join(global.dataDir, 'sessions.json');
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) { return []; }
});

ipcMain.handle('delete-session', async (event, id) => {
  try {
    const p = path.join(global.dataDir, 'sessions.json');
    if (!fs.existsSync(p)) return;
    let sessions = JSON.parse(fs.readFileSync(p, 'utf-8'));
    sessions = sessions.filter(s => s.id !== id);
    fs.writeFileSync(p, JSON.stringify(sessions));
  } catch (err) { /* ignore */ }
});

// ── IPC: catalog products for manual override + library browsing ─────────────
ipcMain.handle('get-catalog-products', async () => {
  try {
    // Ensure the catalog is fetched — if the user hits the Library/Catalog
    // view before running an analysis, the catalog wouldn't otherwise be
    // loaded. `loadCatalog()` is a no-op when already loaded.
    await loadCatalog();

    const raw = getCondensedCatalog();
    if (!raw) return [];
    return JSON.parse(raw)
      .map(p => ({ id: p.id, name: p.name, type: p.role || p.application || p.family || '' }))
      .filter(p => p.name)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } catch (err) {
    console.error('get-catalog-products failed:', err);
    return [];
  }
});

// ── IPC: open email client ────────────────────────────────────────────────────
ipcMain.handle('open-email', async (event, { to, subject, body }) => {
  try {
    const url = 'mailto:' + encodeURIComponent(to || '') +
      '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
    await shell.openExternal(url);
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

// ── IPC: open a URL in the user's default browser ─────────────────────────────
ipcMain.handle('open-external', async (event, url) => {
  try {
    // Only allow http(s) and mailto — guard against file:// or other schemes
    if (typeof url !== 'string') throw new Error('Invalid URL');
    if (!/^(https?:|mailto:)/i.test(url)) throw new Error('Unsupported URL scheme');
    await shell.openExternal(url);
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

// ── IPC: renderer-initiated telemetry ───────────────────────────────────────
// Bridges renderer-side track() calls to the main-process telemetry client.
// Allow-list enforcement: only known event names get through, and metadata is
// shallow-validated to keep payloads small + scrubbed of stringly user content.
const RENDERER_ALLOWED_EVENTS = new Set([
  'sample_spec_loaded',
  'onboarding_completed',
  'feature_used',
]);
ipcMain.handle('track-event', async (event, payload) => {
  try {
    const eventName = String((payload && payload.event) || '').trim();
    if (!RENDERER_ALLOWED_EVENTS.has(eventName)) {
      // Unknown event — silently no-op rather than crash the renderer flow.
      return { success: false, error: 'event not allowed' };
    }
    // Cap metadata to prevent runaway payloads from a buggy renderer.
    const metadata = {};
    const incoming = (payload && payload.metadata && typeof payload.metadata === 'object')
      ? payload.metadata : {};
    for (const k of Object.keys(incoming).slice(0, 10)) {
      const v = incoming[k];
      if (typeof v === 'string') metadata[k] = v.slice(0, 200);
      else if (typeof v === 'number' || typeof v === 'boolean') metadata[k] = v;
      // Drop objects/arrays — keep metadata flat.
    }
    track(eventName, metadata).catch(() => {});
    return { success: true };
  } catch (_) {
    return { success: false };
  }
});

// ── IPC: Anthropic API key management (BYO) ─────────────────────────────────
// Lets enterprise customers point Cipher at their own Anthropic account.
// Pricing FAQ documents this as a discount path: BYO key → lower published
// price since usage cost shifts to the customer.
//
// Storage is a small JSON file in dataDir (not electron-store, to keep this
// dependency-free). The file is gitignored implicitly — it lives in userData,
// not the repo. The key is plaintext; on macOS we could harden by writing
// to Keychain via keytar but that's a phase-2 concern.
function userApiKeyPath() {
  const dir = global.dataDir || app.getPath('userData');
  return path.join(dir, 'user-api-key.json');
}

ipcMain.handle('get-api-key-status', async () => {
  try {
    const userKey = (() => {
      try {
        const p = userApiKeyPath();
        if (fs.existsSync(p)) {
          const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
          if (parsed && typeof parsed.apiKey === 'string' && parsed.apiKey.trim()) {
            return parsed.apiKey.trim();
          }
        }
      } catch (_) { /* corrupt */ }
      return null;
    })();
    const bundled = (global.appConfig && global.appConfig.ANTHROPIC_API_KEY) || null;
    return {
      hasUserKey: !!userKey,
      hasBundledKey: !!bundled,
      // Mask everything except the last 4 chars of whichever is active.
      activeSource: userKey ? 'user' : (bundled ? 'bundled' : 'none'),
      activeMaskedTail: (userKey || bundled || '').slice(-4) || null,
    };
  } catch (err) {
    return { hasUserKey: false, hasBundledKey: false, activeSource: 'none', error: err.message };
  }
});

ipcMain.handle('save-user-api-key', async (event, key) => {
  try {
    const trimmed = String(key || '').trim();
    if (!trimmed) return { success: false, error: 'API key is empty.' };
    if (!trimmed.startsWith('sk-ant-')) {
      return { success: false, error: 'That doesn\'t look like an Anthropic API key (should start with sk-ant-).' };
    }
    const dir = global.dataDir || app.getPath('userData');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      userApiKeyPath(),
      JSON.stringify({ apiKey: trimmed, savedTs: new Date().toISOString() }, null, 2),
      'utf-8'
    );
    // Reset the cached Anthropic client so the next request picks up the
    // new key without an app restart.
    try {
      const claudeService = require('../services/claude');
      if (claudeService && typeof claudeService.resetClient === 'function') {
        claudeService.resetClient();
      }
    } catch (_) { /* non-fatal */ }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
});

ipcMain.handle('clear-user-api-key', async () => {
  try {
    const p = userApiKeyPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
    try {
      const claudeService = require('../services/claude');
      if (claudeService && typeof claudeService.resetClient === 'function') {
        claudeService.resetClient();
      }
    } catch (_) { /* non-fatal */ }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
});

// ── IPC: sample spec discovery ───────────────────────────────────────────────
// Returns the absolute path to a bundled sample-spec PDF if one exists at
// assets/samples/sample-spec.pdf (relative to the app root). Lets the renderer
// show a "Try with a sample spec" button to prospects on first launch.
//
// Resolution paths:
//   Packaged:    process.resourcesPath/app/assets/samples/sample-spec.pdf
//                process.resourcesPath/app.asar/assets/samples/sample-spec.pdf
//                process.resourcesPath/assets/samples/sample-spec.pdf
//   Unpackaged:  <project root>/assets/samples/sample-spec.pdf
//
// Returns:
//   { available: true, path: '...' }  — file exists and is readable
//   { available: false }              — no sample bundled with this build
ipcMain.handle('get-sample-spec', async () => {
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, 'app', 'assets', 'samples', 'sample-spec.pdf'),
        path.join(process.resourcesPath, 'app.asar', 'assets', 'samples', 'sample-spec.pdf'),
        path.join(process.resourcesPath, 'assets', 'samples', 'sample-spec.pdf'),
      ]
    : [
        path.join(__dirname, '..', '..', 'assets', 'samples', 'sample-spec.pdf'),
      ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return { available: true, path: p };
    } catch (_) { /* keep trying */ }
  }
  return { available: false };
});

// ── IPC: in-app feedback ─────────────────────────────────────────────────────
// Posts to https://007technologies.com/api/feedback with the same X-Telemetry-Key
// shared secret used by /api/telemetry. Endpoint stores the message in D1
// and emails Reed via Resend.
//
// Returns:
//   { success: true }                   — captured + email queued
//   { success: false, error: string }   — validation, network, or server error
//
// Failure modes (silent no-op on missing config, rather than throwing):
//   - No global.appConfig → "Feedback isn't configured for this build"
//   - Missing endpoint/key → same message
//   - Server returns non-2xx → bubble its error string up
ipcMain.handle('send-feedback', async (event, payload) => {
  try {
    const cfg = global.appConfig || {};
    // Feedback endpoint is colocated with telemetry — same domain, same key.
    // Derive the URL by swapping /api/telemetry → /api/feedback so we don't
    // need a new config entry shipped to existing customers.
    const telemetryEndpoint = cfg.TELEMETRY_ENDPOINT;
    const key = cfg.TELEMETRY_KEY;
    const customerId = cfg.CUSTOMER_ID;
    if (!telemetryEndpoint || !key || !customerId) {
      return { success: false, error: 'Feedback isn’t configured for this build.' };
    }
    const feedbackEndpoint = telemetryEndpoint.replace(/\/telemetry\/?$/, '/feedback');

    const category = String(payload && payload.category || 'other').toLowerCase();
    const body     = String(payload && payload.body || '').trim();
    const userEmail = String(payload && payload.user_email || '').trim().toLowerCase();
    if (!body) return { success: false, error: 'Please type something before sending.' };
    if (body.length > 8192) return { success: false, error: 'Feedback is too long (8 KB max).' };

    const requestBody = {
      customer_id: customerId,
      product: 'skyfall',
      version: app.getVersion(),
      platform: process.platform,
      category,
      body,
      user_email: userEmail || undefined,
      client_ts: new Date().toISOString(),
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let res;
    try {
      res = await fetch(feedbackEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telemetry-Key': key,
        },
        body: JSON.stringify(requestBody),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let errMsg = 'Server returned ' + res.status;
      try {
        const errBody = await res.json();
        if (errBody && errBody.error) errMsg = errBody.error;
      } catch (_) { /* ignore */ }
      return { success: false, error: errMsg };
    }
    // Fire-and-forget telemetry so feedback events show up in /admin/ Activity
    // and the Stats donut. Body is intentionally NOT included — telemetry must
    // not log user-typed content. We send only the category + length.
    track('feedback_sent', {
      category,
      body_length: body.length,
      had_email: !!userEmail,
    }).catch(() => {});
    return { success: true };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (/abort/i.test(msg)) return { success: false, error: 'Network timeout. Try again.' };
    return { success: false, error: msg };
  }
});

// ── IPC: AI query bar (Haiku-powered) ─────────────────────────────────────────
ipcMain.handle('ask-question', async (event, question, context) => {
  try {
    if (!question || !String(question).trim()) {
      return { success: false, error: 'Please enter a question.' };
    }
    const result = await askQuestion(String(question).trim(), context || {});
    return { success: true, answer: result.answer };
  } catch (err) {
    return { success: false, error: friendlyError(err) };
  }
});

// ── IPC: Drafts persistence ──────────────────────────────────────────────────
ipcMain.handle('save-draft', async (event, draftData) => {
  try {
    const p = path.join(global.dataDir, 'drafts.json');
    let drafts = [];
    if (fs.existsSync(p)) drafts = JSON.parse(fs.readFileSync(p, 'utf-8'));
    // Replace existing draft by id if present, otherwise prepend
    const id = draftData.id || ('draft-' + Date.now());
    const entry = { ...draftData, id, savedAt: new Date().toISOString() };
    drafts = drafts.filter(d => d.id !== id);
    drafts.unshift(entry);
    drafts = drafts.slice(0, 25);
    fs.writeFileSync(p, JSON.stringify(drafts));
    return { success: true, id };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('load-drafts', async () => {
  try {
    const p = path.join(global.dataDir, 'drafts.json');
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) { return []; }
});

ipcMain.handle('delete-draft', async (event, id) => {
  try {
    const p = path.join(global.dataDir, 'drafts.json');
    if (!fs.existsSync(p)) return { success: true };
    let drafts = JSON.parse(fs.readFileSync(p, 'utf-8'));
    drafts = drafts.filter(d => d.id !== id);
    fs.writeFileSync(p, JSON.stringify(drafts));
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

// ── IPC: read the user guide markdown (for in-app reader) ─────────────────────
ipcMain.handle('read-user-guide', async () => {
  try {
    const candidates = app.isPackaged
      ? [
          path.join(process.resourcesPath, 'USER-GUIDE.md'),
          path.join(process.resourcesPath, 'app', 'USER-GUIDE.md'),
        ]
      : [
          path.join(__dirname, '..', '..', 'USER-GUIDE.md'),
        ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return { success: true, content: fs.readFileSync(p, 'utf-8') };
    }
    return { success: false, error: 'User guide not found.' };
  } catch (err) { return { success: false, error: err.message }; }
});

// ── IPC: Settings info ────────────────────────────────────────────────────────
ipcMain.handle('get-app-info', async () => {
  try {
    const cfg = global.appConfig || {};
    return {
      success: true,
      version:      app.getVersion(),
      name:         app.getName(),
      electron:     process.versions.electron,
      node:         process.versions.node,
      platform:     process.platform,
      dataDir:      global.dataDir,
      userDataDir:  app.getPath('userData'),
      logsDir:      app.getPath('logs'),
      // Customer ID from the build's bundled config — surfaced in Settings so
      // the user can see at a glance which build they're on. This is also what
      // shows up in admin telemetry, so a customer reading "soprema-davis"
      // here understands what Reed sees on his side.
      customerId:   cfg.CUSTOMER_ID || null,
      // Brand identity for the cover letter, page headers, etc. Defaults to
      // Soprema for legacy builds. When onboarding non-Soprema reps in Q3,
      // swap the BRAND_* config fields per build (no code change needed).
      brand: {
        name:        cfg.BRAND_NAME || 'Soprema',
        nameFull:    cfg.BRAND_NAME_FULL || cfg.BRAND_NAME || 'Soprema USA',
        repTitle:    cfg.BRAND_REP_TITLE || 'Manufacturer Representative',
        productLabel: cfg.BRAND_PRODUCT_LABEL || ((cfg.BRAND_NAME || 'Soprema') + ' product'),
      },
    };
  } catch (err) { return { success: false, error: err.message }; }
});

// ── IPC: manual update check ──────────────────────────────────────────────────
// Fires the autoUpdater immediately rather than waiting for the once-per-hour
// background poll. The renderer surfaces this as a "Check for updates" button
// in Settings.
ipcMain.handle('check-for-updates', async () => {
  try {
    if (!autoUpdater) {
      return { success: false, error: 'Auto-updater not available in this build.' };
    }
    // Note: in dev (non-packaged) builds, autoUpdater short-circuits with a
    // friendly error. Surface that to the user so they're not confused about
    // why nothing happens.
    if (!app.isPackaged) {
      return { success: true, message: 'Auto-update is disabled in dev builds. (You\'re running an unpackaged build.)' };
    }
    const result = await autoUpdater.checkForUpdates();
    if (result && result.updateInfo) {
      const remoteV = result.updateInfo.version;
      const localV = app.getVersion();
      if (remoteV && remoteV !== localV) {
        return { success: true, message: `Update available — v${remoteV} downloading in the background. We'll notify you when it's ready.` };
      }
      return { success: true, message: `You're on the latest version (v${localV}).` };
    }
    return { success: true, message: 'Update check complete.' };
  } catch (err) {
    const msg = (err && err.message) || String(err);
    return { success: false, error: 'Update check failed: ' + msg };
  }
});

ipcMain.handle('reveal-in-finder', async (event, p) => {
  try {
    if (!p || typeof p !== 'string') throw new Error('Invalid path');
    if (!fs.existsSync(p)) {
      // fall back to parent
      const parent = path.dirname(p);
      if (fs.existsSync(parent)) shell.openPath(parent);
      else throw new Error('Path does not exist');
    } else {
      shell.showItemInFolder(p);
    }
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('clear-history', async () => {
  try {
    const sessionsP = path.join(global.dataDir, 'sessions.json');
    const draftsP   = path.join(global.dataDir, 'drafts.json');
    if (fs.existsSync(sessionsP)) fs.unlinkSync(sessionsP);
    if (fs.existsSync(draftsP))   fs.unlinkSync(draftsP);
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});