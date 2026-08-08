/**
 * Preload — the ONLY bridge between the game (renderer) and Steam (main process).
 * Runs in an isolated context, so the game window keeps contextIsolation on and
 * nodeIntegration off. Exposes a tiny, safe `window.steam` surface.
 *
 * In the browser/itch build this file simply isn't present, so `window.steam`
 * is undefined and the game's steamClient.js no-ops.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('steam', {
  // resolves true when Steam is connected (desktop build + Steam running)
  available: () => ipcRenderer.invoke('steam:available'),
  // unlock an achievement by its Steamworks API name
  unlock: (apiName) => ipcRenderer.invoke('steam:unlock', apiName),
});
