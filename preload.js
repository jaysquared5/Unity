'use strict';

const { contextBridge, ipcRenderer, clipboard } = require('electron');

// Bridge exposed to the renderer as `window.avAPI`.
// The renderer never touches Node or Electron internals directly — everything
// goes through these typed, async calls.
contextBridge.exposeInMainWorld('avAPI', {
  // Persistent store (replaces localStorage). All async — callers must await.
  store: {
    get: (key) => ipcRenderer.invoke('store:get', key),
    set: (key, value) => ipcRenderer.invoke('store:set', key, value),
    remove: (key) => ipcRenderer.invoke('store:remove', key),
    getAll: () => ipcRenderer.invoke('store:getAll'),
    clear: () => ipcRenderer.invoke('store:clear')
  },

  // Save a file via the native Save dialog.
  //   defaultPath: suggested filename/path
  //   contents: string to write
  //   filters: [{ name, extensions: [...] }]
  // returns { canceled, filePath? }
  saveFile: ({ defaultPath, contents, filters }) =>
    ipcRenderer.invoke('dialog:saveFile', { defaultPath, contents, filters }),

  // Open an external http(s) URL in the user's default browser.
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // Read plain text from the system clipboard (used by the ticket-# paste
  // helper). Synchronous in Electron's main world, wrapped as a promise so the
  // renderer can `await` it exactly as it did navigator.clipboard.readText().
  readClipboard: () => clipboard.readText()
});
