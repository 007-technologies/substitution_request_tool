const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFile:         ()                          => ipcRenderer.invoke('select-file'),
  analyze:            (filePath)                  => ipcRenderer.invoke('analyze', filePath),
  downloadDatasheet:  (r2Key, filename)           => ipcRenderer.invoke('download-datasheet', r2Key, filename),
  exportPDF:          ()                          => ipcRenderer.invoke('export-pdf'),

  // Step 3: generate substitution request form data via Claude
  generateSubRequest: (matchedData, projectInfo)  => ipcRenderer.invoke('generate-sub-request', matchedData, projectInfo),

  // Step 3: export the rendered substitution request HTML to a PDF file
  exportSubRequestPDF: (htmlContent, filename)    => ipcRenderer.invoke('export-sub-request-pdf', htmlContent, filename),

  onProgress:         (callback) => ipcRenderer.on('progress',       (event, message) => callback(message)),
  onUpdateStatus:     (callback) => ipcRenderer.on('update-status',  (event, data)    => callback(data)),
  installUpdate:      ()         => ipcRenderer.invoke('install-update'),
});
