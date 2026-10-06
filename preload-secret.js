"use strict";
// Pont minimal de la petite fenêtre de saisie d'un secret (jeton GitHub, clé Ragic)
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("secret", { send: v => ipcRenderer.send("secret-result", v) });
