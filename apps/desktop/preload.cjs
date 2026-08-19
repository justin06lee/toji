const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toji', {
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron
  },
  quit: () => ipcRenderer.send('toji:quit'),
  // The main process asks the renderer to open an http(s) link as a Toji web tab.
  onOpenUrl: (callback) => {
    const handler = (_event, url) => callback(url);
    ipcRenderer.on('toji:open-url', handler);
    return () => ipcRenderer.removeListener('toji:open-url', handler);
  },
  // Menu accelerators (Cmd+W / Cmd+T) routed from the main process.
  onCloseTab: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('toji:close-tab', handler);
    return () => ipcRenderer.removeListener('toji:close-tab', handler);
  },
  onNewTab: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('toji:new-tab', handler);
    return () => ipcRenderer.removeListener('toji:new-tab', handler);
  },
  // The main process detects a tap of the Option/Alt key across the app shell AND every
  // <webview> (whose key events never reach this window) and asks us to toggle the agent bar,
  // so it works even while a page is focused or the agent is running.
  onToggleAgent: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('toji:toggle-agent', handler);
    return () => ipcRenderer.removeListener('toji:toggle-agent', handler);
  },
  // Set a dropped file onto a <input type=file> inside a guest <webview> (the agent
  // attaching e.g. a resume). Done in the main process via the Chrome DevTools
  // Protocol because the renderer can't set a file input programmatically.
  // elementId targets the exact input by its byakugan manifest id; inputIndex is the fallback.
  uploadToFileInput: (webContentsId, filePath, inputIndex, elementId) =>
    ipcRenderer.invoke('toji:upload-file-input', { webContentsId, filePath, inputIndex, elementId }),
  // Byakugan page perception for the web agent (runs in the main process over CDP):
  // observe = full render-truthful manifest, diff = only what changed since last step,
  // act = verified click/type/press/select/hover/scroll/navigate on manifest ids,
  // look = cropped screenshot of one element/region for canvas/visual content.
  eyesObserve: (webContentsId, maxTokens) => ipcRenderer.invoke('toji:eyes-observe', { webContentsId, maxTokens }),
  eyesDiff: (webContentsId, maxTokens) => ipcRenderer.invoke('toji:eyes-diff', { webContentsId, maxTokens }),
  eyesAct: (webContentsId, action) => ipcRenderer.invoke('toji:eyes-act', { webContentsId, action }),
  eyesLook: (webContentsId, target) => ipcRenderer.invoke('toji:eyes-look', { webContentsId, ...(target || {}) }),
  // Default-browser registration + Chrome extension loading (unpacked + Web Store).
  setDefaultBrowser: () => ipcRenderer.invoke('toji:set-default-browser'),
  isDefaultBrowser: () => ipcRenderer.invoke('toji:is-default-browser'),
  addExtension: () => ipcRenderer.invoke('toji:add-extension'),
  listExtensions: () => ipcRenderer.invoke('toji:list-extensions'),
  webStoreAvailable: () => ipcRenderer.invoke('toji:web-store-available')
});
