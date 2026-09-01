const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toji', {
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron
  },
  closeWindow: () => ipcRenderer.send('toji:close-window'),
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
  // Window-relative cursor position, streamed from the main process while this window
  // is focused. DOM mouse events go missing over native drag regions, so the top-edge
  // window-drag notch reveals from this instead of hover state.
  onWindowCursor: (callback) => {
    const handler = (_event, cursor) => callback(cursor);
    ipcRenderer.on('toji:window-cursor', handler);
    return () => ipcRenderer.removeListener('toji:window-cursor', handler);
  },
  // Dragging the notch is driven from the main process rather than by a native drag
  // region, so the notch keeps its grab cursor and its double-click. The renderer only
  // says when the grab starts and ends; the main process follows the cursor.
  startWindowDrag: () => ipcRenderer.send('toji:window-drag-start'),
  endWindowDrag: () => ipcRenderer.send('toji:window-drag-end'),
  // Double-clicking the notch does whatever double-clicking a title bar does here
  // (zoom on macOS unless the user chose otherwise, maximize/restore elsewhere).
  windowTitleAction: () => ipcRenderer.send('toji:window-title-action'),
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
  // The screenshot agent's sense: the tab's current pixels plus its CSS viewport size,
  // so image coordinates can be scaled back to real mouse coordinates.
  pageScreenshot: (webContentsId, maxLongEdge) => ipcRenderer.invoke('toji:page-screenshot', { webContentsId, maxLongEdge }),
  // Container egress is encoded in the partition name (see policy.cjs).
  clearContainer: (containerId) => ipcRenderer.invoke('toji:clear-container', containerId),
  // Password vault. Note there is no "read a password" call by design: the renderer can
  // see which credentials exist and ask for one to be filled, but never receives a secret.
  vaultStatus: () => ipcRenderer.invoke('toji:vault-status'),
  vaultList: (containerId) => ipcRenderer.invoke('toji:vault-list', containerId),
  vaultMatches: (webContentsId) => ipcRenderer.invoke('toji:vault-matches', webContentsId),
  vaultSave: (entry) => ipcRenderer.invoke('toji:vault-save', entry),
  vaultDelete: (id) => ipcRenderer.invoke('toji:vault-delete', id),
  vaultGenerate: (length) => ipcRenderer.invoke('toji:vault-generate', length),
  vaultFill: (webContentsId, entryId) => ipcRenderer.invoke('toji:vault-fill', { webContentsId, entryId }),
  // A submitted login is held in the main process; the renderer only learns the origin
  // and username, and decides whether it gets committed.
  vaultCommit: (webContentsId) => ipcRenderer.invoke('toji:vault-commit', webContentsId),
  vaultDismiss: (webContentsId) => ipcRenderer.invoke('toji:vault-dismiss', webContentsId),
  onVaultPrompt: (callback) => {
    const handler = (_event, prompt) => callback(prompt);
    ipcRenderer.on('toji:vault-prompt', handler);
    return () => ipcRenderer.removeListener('toji:vault-prompt', handler);
  },
  // The preload every <webview> guest loads: detects login forms and performs the fill
  // in-page, so the password goes main -> guest without passing through the renderer.
  guestPreload: ipcRenderer.sendSync('toji:guest-preload-url'),

  // Tor: lifecycle + live bootstrap status. Containers set to Tor egress stay offline
  // (their traffic is cancelled, never sent direct) until this reports ready.
  torStatus: () => ipcRenderer.invoke('toji:tor-status'),
  torStart: () => ipcRenderer.invoke('toji:tor-start'),
  torStop: () => ipcRenderer.invoke('toji:tor-stop'),
  torNewCircuit: () => ipcRenderer.invoke('toji:tor-new-circuit'),
  onTorStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('toji:tor-status', handler);
    return () => ipcRenderer.removeListener('toji:tor-status', handler);
  },
  // Default-browser registration + Chrome extension loading (unpacked + Web Store).
  setDefaultBrowser: () => ipcRenderer.invoke('toji:set-default-browser'),
  isDefaultBrowser: () => ipcRenderer.invoke('toji:is-default-browser'),
  addExtension: () => ipcRenderer.invoke('toji:add-extension'),
  listExtensions: () => ipcRenderer.invoke('toji:list-extensions'),
  webStoreAvailable: () => ipcRenderer.invoke('toji:web-store-available')
});
