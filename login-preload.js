"use strict";
// Pont minimal pour la fenêtre de connexion
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("agoaLogin", {
  start: () => ipcRenderer.send("login-start"),
  quit: () => ipcRenderer.send("login-quit"),
  onStatus: cb => ipcRenderer.on("login-status", (e, kind, text) => cb(kind, text))
});
