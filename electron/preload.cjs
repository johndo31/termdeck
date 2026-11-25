const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("termdeckDesktop", {
  isDesktop: true,
  isMac: process.platform === "darwin",
  setBadge(count) {
    ipcRenderer.send("termdeck:badge", Number(count) || 0);
  },
  pickFolder(defaultPath) {
    return ipcRenderer.invoke("termdeck:pick-folder", defaultPath);
  },
  onFontZoom(callback) {
    ipcRenderer.on("termdeck:font-zoom", (_event, delta) => callback(delta));
  },
});
