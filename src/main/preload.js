const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFile:         ()                          => ipcRenderer.invoke('select-file'),
  analyze:            (filePath)                  => ipcRenderer.invoke('analyze', filePath),
  downloadDatasheet:  (r2Key, filename)           => ipcRenderer.invoke('download-datasheet', r2Key, filename),
  exportPDF:          ()                          => ipcRenderer.invoke('export-pdf'),

  // Step 3: generate substitution request form data via Claude
  generateSubRequest: (matchedData, projectInfo)  => ipcRenderer.invoke('generate-sub-request', matchedData, projectInfo),

  // Step 3: export the rendered substitution request HTML to a PDF file
  exportSubRequestPDF: (htmlContent, filename)    => ipcRenderer.invoke('export-sub-request-pdf', htmlContent, filename),

  // Step 3b: export a bundled submission package — cover letter + sub-request +
  // all referenced Soprema product datasheets, merged into a single PDF.
  // Args: { coverLetterHTML, subRequestHTML, datasheets: [{r2Key, filename}], filename }
  exportBundlePDF: (data) => ipcRenderer.invoke('export-bundle-pdf', data),

  onProgress:         (callback) => ipcRenderer.on('progress',       (event, message) => callback(message)),
  onUpdateStatus:     (callback) => ipcRenderer.on('update-status',  (event, data)    => callback(data)),
  onLicenseStatus:    (callback) => ipcRenderer.on('license-status', (event, data)    => callback(data)),
  installUpdate:      ()         => ipcRenderer.invoke('install-update'),
  getFilePath:        (file)     => webUtils.getPathForFile(file),
  saveSession:        (data)     => ipcRenderer.invoke('save-session', data),
  loadSessions:       ()         => ipcRenderer.invoke('load-sessions'),
  deleteSession:      (id)       => ipcRenderer.invoke('delete-session', id),
  getCatalogProducts: ()         => ipcRenderer.invoke('get-catalog-products'),
  openEmail:          (opts)     => ipcRenderer.invoke('open-email', opts),

  // Open an external URL in the user's default browser
  openExternal:       (url)      => ipcRenderer.invoke('open-external', url),

  // AI query bar — ask a question about the extracted spec + matched products
  askQuestion:        (question, context) => ipcRenderer.invoke('ask-question', question, context),

  // Drafts — persist in-progress substitution requests
  saveDraft:          (data)     => ipcRenderer.invoke('save-draft', data),
  loadDrafts:         ()         => ipcRenderer.invoke('load-drafts'),
  deleteDraft:        (id)       => ipcRenderer.invoke('delete-draft', id),

  // Read a user guide markdown file (bundled with the app)
  readUserGuide:      ()         => ipcRenderer.invoke('read-user-guide'),

  // App info for Settings pane
  getAppInfo:         ()         => ipcRenderer.invoke('get-app-info'),
  revealInFinder:     (p)        => ipcRenderer.invoke('reveal-in-finder', p),
  clearHistory:       ()         => ipcRenderer.invoke('clear-history'),
  // Manual "Check for updates" button — fires autoUpdater immediately
  checkForUpdates:    ()         => ipcRenderer.invoke('check-for-updates'),

  // BYO Anthropic API key — for enterprise customers running Cipher against
  // their own Anthropic account. See pricing FAQ.
  getApiKeyStatus:    ()         => ipcRenderer.invoke('get-api-key-status'),
  saveUserApiKey:     (key)      => ipcRenderer.invoke('save-user-api-key', key),
  clearUserApiKey:    ()         => ipcRenderer.invoke('clear-user-api-key'),

  // Sample-spec lookup — returns { available, path? }. Renderer uses this to
  // show the "Try with a sample spec" button if a sample is bundled.
  getSampleSpec:      ()         => ipcRenderer.invoke('get-sample-spec'),

  // Renderer-initiated telemetry — for events the renderer is uniquely
  // positioned to know about (sample-spec clicks, UI toggles). Main process
  // events still go through main-side track() directly. Body must not include
  // user-typed content; the main-side handler enforces this.
  trackEvent:         (event, metadata) => ipcRenderer.invoke('track-event', { event, metadata }),

  // In-app feedback — POSTs to /api/feedback (auth via TELEMETRY_KEY).
  // Body: { category: 'bug'|'idea'|'praise'|'other', body: string, user_email?: string }
  // Returns { ok: true } on success or { ok: false, error: '...' } on failure.
  sendFeedback:       (payload)  => ipcRenderer.invoke('send-feedback', payload),
});