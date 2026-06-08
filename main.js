'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const store = require('./src/main/store');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1a1a1a', // operator-facing tool is dark theme
    title: 'AV Readiness',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));

  // Safety net: any attempt to open a new window (e.g. an <a target="_blank">)
  // is routed to the default browser rather than spawning an Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Defense in depth: the window only ever shows the bundled local page. Block
  // any in-window navigation; route http(s) attempts out to the browser.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// IPC: persistent store (replaces browser localStorage)
// ---------------------------------------------------------------------------
ipcMain.handle('store:get', (_e, key) => store.get(key));
ipcMain.handle('store:set', (_e, key, value) => store.set(key, value));
ipcMain.handle('store:remove', (_e, key) => store.remove(key));
ipcMain.handle('store:getAll', () => store.getAll());
ipcMain.handle('store:clear', () => store.clear());

// ---------------------------------------------------------------------------
// IPC: save a file via native dialog (replaces showSaveFilePicker / blob download)
//   filters example: [{ name: 'HTML Report', extensions: ['html'] }]
//   returns { canceled: boolean, filePath?: string }
// ---------------------------------------------------------------------------
ipcMain.handle('dialog:saveFile', async (_e, { defaultPath, contents, filters }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath,
    filters: filters || []
  });
  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }
  await fs.promises.writeFile(result.filePath, contents, 'utf8');
  return { canceled: false, filePath: result.filePath };
});

// ---------------------------------------------------------------------------
// IPC: open an external URL in the default browser
//   (replaces <a target="_blank"> for the ServiceNow prefill link, etc.)
// ---------------------------------------------------------------------------
ipcMain.handle('shell:openExternal', (_e, url) => {
  // Only allow http(s) to avoid opening arbitrary protocols.
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    return shell.openExternal(url);
  }
  return Promise.reject(new Error('Refused to open non-http(s) URL'));
});

// ---------------------------------------------------------------------------
// IPC: read plain text from the system clipboard. Lives in the main process so
// the renderer can stay fully sandboxed (preload needs no Electron modules
// beyond ipcRenderer/contextBridge).
// ---------------------------------------------------------------------------
ipcMain.handle('clipboard:readText', () => clipboard.readText());

// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  // Drop the default macOS/Windows menu noise; keep it minimal for an internal tool.
  Menu.setApplicationMenu(null);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
