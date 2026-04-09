const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

const { loadCatalog, getCondensedCatalog, getDocumentsList } = require('../services/catalog');
const { extractProducts, matchProducts, generateSubstitutionRequest } = require('../services/claude');
const { fetchDocumentBuffer } = require('../services/r2');

let mainWindow;

// ─── Config ────────────────────────────────────────────────────────────────
const configPath = process.resourcesPath
  ? path.join(process.resourcesPath, 'config.json')
  : path.join(__dirname, '..', '..', 'config.json');

global.appConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
global.dataDir = path.join(app.getPath('userData'), 'cache');
fs.mkdirSync(global.dataDir, { recursive: true });

// ─── Window ─────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  autoUpdater.checkForUpdatesAndNotify();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── IPC: File Select ────────────────────────────────────────────────────────
ipcMain.handle('select-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

// ─── IPC: Step 1 + 2 — Analyze spec PDF ─────────────────────────────────────
ipcMain.handle('analyze', async (event, filePath) => {
  try {
    mainWindow.webContents.send('progress', 'Loading Soprema catalog…');
    const pdfBuffer = fs.readFileSync(filePath);
    await loadCatalog();

    mainWindow.webContents.send('progress', 'Extracting products from spec…');
    const extracted = await extractProducts(pdfBuffer);

    mainWindow.webContents.send('progress', 'Matching to Soprema catalog…');
    const matched = await matchProducts(extracted, getCondensedCatalog(), getDocumentsList());

    return { success: true, data: { extracted, matched } };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Step 3 — Generate Substitution Request ─────────────────────────────
ipcMain.handle('generate-sub-request', async (event, matchedData, projectInfo) => {
  try {
    mainWindow.webContents.send('progress', 'Generating substitution request…');
    const subRequest = await generateSubstitutionRequest(matchedData, projectInfo);
    return { success: true, data: subRequest };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Export comparison chart as PDF ────────────────────────────────────
ipcMain.handle('export-pdf', async () => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: 'soprema-comparison.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled) return { success: false };
    const pdfData = await mainWindow.webContents.printToPDF({ printBackground: true });
    fs.writeFileSync(result.filePath, pdfData);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Export substitution request as PDF ─────────────────────────────────
//
// The renderer sends the fully-rendered HTML string of the sub-request form.
// We spin up a hidden BrowserWindow, load that HTML, print to PDF, and save.
//
ipcMain.handle('export-sub-request-pdf', async (event, htmlContent, suggestedFilename) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: suggestedFilename || 'substitution-request.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled) return { success: false };

    // Spin up a hidden window to render and print the HTML
    const printWin = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    // Use a data URI so we don't need a file on disk
    await printWin.loadURL(
      'data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent)
    );

    const pdfData = await printWin.webContents.printToPDF({
      printBackground: true,
      pageSize: 'Letter',
      margins: { top: 0.75, bottom: 0.75, left: 0.75, right: 0.75 },
    });

    printWin.close();
    fs.writeFileSync(result.filePath, pdfData);
    return { success: true, filePath: result.filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Download datasheet from R2 ────────────────────────────────────────
ipcMain.handle('download-datasheet', async (event, r2Key, filename) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: filename,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled) return { success: false };
    const buffer = await fetchDocumentBuffer(r2Key);
    fs.writeFileSync(result.filePath, buffer);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── Auto-updater events ─────────────────────────────────────────────────────
autoUpdater.on('update-available', () => {
  mainWindow.webContents.send('update-status', { status: 'available' });
});

autoUpdater.on('update-downloaded', () => {
  mainWindow.webContents.send('update-status', { status: 'ready' });
});

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall();
});
