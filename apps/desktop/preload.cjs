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
  }
});
