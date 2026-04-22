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

const { fetchDocumentBuffer } = require('../services/r2');
// FIX: added getCondensedCatalog — required by the get-catalog-products handler
const { loadCatalog, getFilteredCatalog, getDocumentsList, getCondensedCatalog } = require('../services/catalog');
const { extractProducts, matchProducts, generateSubstitutionRequest } = require('../services/claude');
const { extractRoofingText, extractRoofingPages } = require('../services/pdfExtractor');

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

// ── Splash screen ─────────────────────────────────────────────────────────────
function createSplashWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const splash = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    resizable: true,
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
  });
  splash.loadFile(path.join(__dirname, '..', 'renderer', 'splash.html'));
  return splash;
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Soprema Substitution Tool',
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

  const splash = createSplashWindow();

  createWindow();

  let mainReady = false;

  mainWindow.once('ready-to-show', () => {
    mainReady = true;
  });

  splash.on('closed', () => {
    if (mainReady) {
      mainWindow.show();
    } else {
      mainWindow.once('ready-to-show', () => mainWindow.show());
    }
  });

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

// ── IPC: catalog products for manual override ─────────────────────────────────
ipcMain.handle('get-catalog-products', async () => {
  try {
    const raw = getCondensedCatalog();
    if (!raw) return [];
    return JSON.parse(raw)
      .map(p => ({ id: p.id, name: p.name, type: p.role || p.application || p.family || '' }))
      .filter(p => p.name)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } catch (err) { return []; }
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