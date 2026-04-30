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
const { track } = require('../services/telemetry');

// ── Friendly error messages ───────────────────────────────────────────────────
function friendlyError(err) {
  const msg = err?.message || String(err);
  if (msg.includes('rate_limit') || err?.status === 429)
    return 'Too many requests — please wait a moment and try again.';
  if (msg.includes('invalid_api_key') || msg.includes('authentication'))
    return 'Invalid Anthropic API key. Check your config.json and restart the app.';
  if (msg.includes('Could not read PDF') || msg.includes('scanned'))
    return 'Could not read this PDF. Make sure it\'s a text-based PDF, not a scanned image.';
  if (msg.includes('No readable text'))
    return 'No readable text found in this PDF. Please use a text-based (not scanned) PDF.';
  if (msg.includes('Failed to parse Claude response'))
    return 'An unexpected response was received. Please try again.';
  if (msg.includes('ENOTFOUND') || msg.includes('network') || msg.includes('fetch'))
    return 'Network error — check your internet connection and try again.';
  if (msg.includes('R2') || msg.includes('fetchMetadata') || msg.includes('NoSuchKey'))
    return 'Could not load the Soprema product catalog. Check your Cloudflare R2 credentials in config.json.';
  return msg;
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
    sendProgress('Extracting roofing content from PDF...');
    track('spec_uploaded', { fileName: path.basename(filePath || '') });

    const pdfBuffer = fs.readFileSync(filePath);
    const pages = await extractRoofingPages(pdfBuffer);

    sendProgress('Loading Soprema product catalog...');
    await loadCatalog();

    sendProgress('Analyzing specification... (this may take 20-40 seconds)');
    const extracted = await extractProducts(pages, sendProgress);

    sendProgress('Matching products to Soprema catalog...');

    const productTypes = (extracted.products || [])
      .map((p) => p.product_type)
      .filter(Boolean);

    const filteredCatalog = getFilteredCatalog(productTypes);
    const documentsList = getDocumentsList();

    // Strip citation data before sending to Step 2 — citations are only needed
    // in the UI and add significant token overhead that matchProducts doesn't use.
    const extractedForMatching = {
      ...extracted,
      sourcePages: undefined,
      products: (extracted.products || []).map(({ citations, ...rest }) => rest),
    };

    const matched = await matchProducts(extractedForMatching, filteredCatalog, documentsList, sendProgress);


    sendProgress('Analysis complete!');

    return {
      success: true,
      data: { extracted, matched },
    };
  } catch (err) {
    console.error('Analysis error:', err);
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
    return { success: false, error: err.message };
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
    return { success: false, error: err.message };
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
    return { success: false, error: err.message };
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
    return { success: false, error: err.message };
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
    };
  } catch (err) { return { success: false, error: err.message }; }
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