/**
 * IPC bridge for the find-bar WebContentsView.
 *
 * The bar lives in its own webContents (a child `WebContentsView` of the app window), not in
 * the DSH page. That separation is what keeps the caret in the bar: Chromium's find-in-page
 * focuses the matched text, which would blur an input that lived in the same page and reset
 * the find session on every "next".
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshFind', {
  search: (payload) => ipcRenderer.invoke('findbar:find', payload),
  close: () => ipcRenderer.invoke('findbar:close'),
  onShow: (fn) => ipcRenderer.on('findbar:show', (_event, payload) => fn(payload)),
  onResult: (fn) => ipcRenderer.on('findbar:result', (_event, payload) => fn(payload)),
  onFocus: (fn) => ipcRenderer.on('findbar:focus', () => fn()),
})
