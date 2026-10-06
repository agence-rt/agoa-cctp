"use strict";
// AGOA CCTP — processus principal Electron
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");

const pkg = require("./package.json");
const INFO = { version: pkg.version, deploiement: (pkg.agoa && pkg.agoa.deploiement) || 0 };

let win = null;
let pendingFile = null; // fichier .cctp à ouvrir dès que l'interface est prête
let ready = false;
let allowClose = false;   // vrai une fois la fermeture confirmée (ou pendant une mise à jour)
let closing = false;

/* ---------- fichiers de données (dans %APPDATA%\AGOA CCTP) ---------- */
const userDir = () => app.getPath("userData");
const dataPath = () => path.join(userDir(), "agoa-cctp-donnees.json");
const configPath = () => path.join(userDir(), "agoa-cctp-config.json");

function readJson(p, def) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return def; } }
function writeAtomic(p, text) {
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, text, "utf8");
  if (fs.existsSync(p)) fs.copyFileSync(p, p + ".bak"); // copie de secours de la version précédente
  fs.renameSync(tmp, p);
}

/* ---------- ouverture d'un .cctp passé en argument (double-clic) ---------- */
function agoarvFromArgs(argv) { return argv.find(a => /\.(cctp|dce)$/i.test(a) && fs.existsSync(a)) || null; }
function openAgoarv(file) {
  if (!file) return;
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { dialog.showErrorBox("AGOA CCTP", "Impossible de lire " + file); return; }
  if (win && ready) win.webContents.send("open-file", path.basename(file), text, file);
  else pendingFile = { name: path.basename(file), text, file };
}

/* ---------- secrets (clé Ragic, jeton GitHub) : chiffrés avec le compte Windows quand c'est possible ---------- */
function getSecret(name) {
  const c = readJson(configPath(), {});
  const v = c[name];
  if (!v) return "";
  if (typeof v === "object" && v.enc) { try { return safeStorage.decryptString(Buffer.from(v.enc, "base64")); } catch { return ""; } }
  return String(v);
}
function setSecret(name, value) {
  const c = readJson(configPath(), {});
  if (!value) delete c[name];
  else c[name] = safeStorage.isEncryptionAvailable() ? { enc: safeStorage.encryptString(value).toString("base64") } : value;
  writeAtomic(configPath(), JSON.stringify(c, null, 2));
}
function askSecret(title, label, help) {
  return new Promise(resolve => {
    const w = new BrowserWindow({ parent: win, modal: true, width: 520, height: 330, resizable: false, minimizable: false, maximizable: false,
      title, autoHideMenuBar: false, icon: path.join(__dirname, "build", "icon.ico"),
      webPreferences: { preload: path.join(__dirname, "preload-secret.js"), contextIsolation: true, nodeIntegration: false } });
    w.setMenu(null);
    let done = false;
    const finish = v => { if (done) return; done = true; resolve(v); };
    ipcMain.once("secret-result", (e, v) => { finish(v); w.close(); });
    w.on("closed", () => finish(null));
    w.loadFile(path.join(__dirname, "app", "secret.html"), { query: { title, label, help } });
  });
}

/* ---------- API Ragic (HTTP) ---------- */
function ragicCfg() {
  const c = readJson(configPath(), {});
  const key = getSecret("ragicKey");
  if (!key) throw new Error("[no_key] Clé API Ragic manquante : Aide, Clé API Ragic…");
  return { host: (c.ragicHost || "https://eu2.ragic.com").replace(/\/+$/, ""), key };
}
async function ragicGet(url, key) {
  let r;
  try { r = await fetch(url, { headers: { Authorization: "Basic " + key } }); }
  catch (e) { throw new Error("[network] " + e.message); }
  if (r.status === 401 || r.status === 403) throw new Error("[auth] Accès refusé par Ragic");
  if (!r.ok) throw new Error("[tool_error] Ragic HTTP " + r.status);
  const j = await r.json();
  if (j && j.status === "ERROR") throw new Error("[tool_error] " + (j.msg || "Erreur Ragic"));
  return j;
}
function whereParams(filters) {
  return Object.entries(filters || {}).map(([fid, f]) => {
    const op = f && f.op === "like" ? "like" : "eq";
    return "&where=" + encodeURIComponent(`${fid},${op},${f.value}`);
  }).join("");
}
const toList = obj => Object.entries(obj || {}).filter(([k]) => /^\d+$/.test(k)).map(([id, rec]) => ({ id: Number(id), rec }));

async function ragic(tool, input) {
  const { host, key } = ragicCfg();
  const base = `${host}/${input.apname}${input.sheet_id}`;
  if (tool === "list_page") {
    const j = await ragicGet(`${base}?api&v=3&limit=${input.limit || 25}${whereParams(input.filters)}`, key);
    return { records: toList(j).map(x => ({ record_id: x.id, ...x.rec })) };
  }
  if (tool === "get_records") {
    if (input.record_id != null) {
      const ids = [].concat(input.record_id);
      const out = [];
      for (const id of ids) { const j = await ragicGet(`${base}/${id}?api&v=3`, key); const rec = j[String(id)] || Object.values(j)[0]; if (rec) out.push({ record_id: id, record: rec }); }
      return { records: out };
    }
    const j = await ragicGet(`${base}?api&v=3&limit=${input.count || 50}${whereParams(input.filters)}`, key);
    return { records: toList(j).map(x => ({ record_id: x.id, record: x.rec })) };
  }
  throw new Error("[tool_error] Outil inconnu : " + tool);
}

/* ---------- mises à jour (Releases GitHub du dépôt privé agence-rt/agoa-cctp) ---------- */
// Le dépôt est privé : chaque poste a besoin d'un jeton GitHub en lecture seule (Contents : Read)
// enregistré une fois via Aide, « Accès aux mises à jour ».
const REPO = { owner: "agence-rt", repo: "agoa-cctp" };
let updater = null;
let updateState = "idle"; // idle | checking | proposed | downloading | ready
let manualCheck = false;
const notesText = info => {
  const n = info && info.releaseNotes;
  const t = Array.isArray(n) ? n.map(x => x.note || "").join("\n") : (n || "");
  return String(t).replace(/<[^>]+>/g, "").trim();
};
async function proposeUpdate(info) {
  if (updateState === "downloading" || updateState === "ready") return;
  updateState = "proposed";
  const notes = notesText(info);
  const r = await dialog.showMessageBox(win, {
    type: "info", buttons: ["Mettre à jour maintenant", "Plus tard"], defaultId: 0, cancelId: 1, noLink: true,
    title: "Mise à jour disponible",
    message: `AGOA CCTP ${info.version} est disponible.`,
    detail: `Version installée : ${INFO.version} (déploiement n°${INFO.deploiement}).` + (notes ? `\n\nNouveautés :\n${notes}` : "") +
      "\n\nLa mise à jour se télécharge puis l'application redémarre. Vos affaires et fichiers .cctp ne sont pas modifiés."
  });
  if (r.response !== 0) { updateState = "idle"; return; }
  updateState = "downloading";
  win.setTitle(`AGOA CCTP — téléchargement de la mise à jour ${info.version}…`);
  updater.downloadUpdate().catch(err => {
    updateState = "idle"; win.setProgressBar(-1); win.setTitle(`AGOA CCTP — v${INFO.version}`);
    dialog.showErrorBox("Mise à jour", "Le téléchargement a échoué : " + (err && err.message ? err.message : err));
  });
}
function applyFeed() {
  const token = getSecret("githubToken");
  if (!token) return false;
  updater.setFeedURL({ provider: "github", owner: REPO.owner, repo: REPO.repo, private: true, token, releaseType: "release" });
  return true;
}
async function askUpdateToken() {
  const v = await askSecret("Accès aux mises à jour", "Jeton GitHub (lecture seule)",
    "Le dépôt agoa-cctp est privé. Collez ici un jeton GitHub (fine-grained) limité au dépôt agence-rt/agoa-cctp avec la permission « Contents : Read-only ». Il est conservé chiffré sur ce poste.");
  if (v === null) return false;
  setSecret("githubToken", v.trim());
  return !!v.trim();
}
async function askRagicKey() {
  const v = await askSecret("Clé API Ragic", "Clé API Ragic",
    "Ragic, menu du compte, Personal Settings, API Key. La clé est conservée chiffrée sur ce poste et sert à retrouver les opérations par leur code.");
  if (v === null) return;
  setSecret("ragicKey", v.trim());
}
async function runCheck(manual) {
  if (!app.isPackaged || !updater) {
    if (manual) dialog.showMessageBox(win, { type: "info", message: "Disponible uniquement dans la version installée." });
    return;
  }
  if (updateState === "downloading" || updateState === "ready") return;
  if (!applyFeed()) {
    if (manual || !readJson(configPath(), {}).tokenAsked) {
      writeAtomic(configPath(), JSON.stringify({ ...readJson(configPath(), {}), tokenAsked: true }, null, 2));
      const r = await dialog.showMessageBox(win, { type: "info", buttons: ["Saisir le jeton", "Plus tard"], defaultId: 0, cancelId: 1, noLink: true,
        title: "Mises à jour", message: "Les mises à jour automatiques ne sont pas encore activées sur ce poste.",
        detail: "Le dépôt des versions est privé : un jeton GitHub en lecture seule est nécessaire (une seule fois). Vous pouvez aussi le saisir plus tard dans Aide, Accès aux mises à jour." });
      if (r.response !== 0 || !(await askUpdateToken()) || !applyFeed()) return;
    } else return;
  }
  manualCheck = !!manual;
  updateState = "checking";
  try {
    const r = await updater.checkForUpdates();
    const v = r && r.updateInfo && r.updateInfo.version;
    if (updateState === "checking") {
      updateState = "idle";
      if (manual) dialog.showMessageBox(win, { type: "info", title: "Mises à jour", message: "AGOA CCTP est à jour.", detail: `Version ${INFO.version} (déploiement n°${INFO.deploiement}).${v && v !== INFO.version ? "" : ""}` });
    }
  } catch (err) {
    updateState = "idle";
    const msg = String(err && err.message || err);
    if (manual || /401|403|404|Bad credentials/i.test(msg)) {
      const bad = /401|403|404|Bad credentials/i.test(msg);
      const r = await dialog.showMessageBox(win, { type: "warning", buttons: bad ? ["Ressaisir le jeton", "Fermer"] : ["Fermer"], defaultId: 0, cancelId: bad ? 1 : 0, noLink: true,
        title: "Mises à jour", message: bad ? "GitHub a refusé l'accès aux versions." : "GitHub est injoignable.",
        detail: bad ? "Le jeton est peut-être expiré ou n'a pas accès au dépôt agoa-cctp." : "Vérifiez la connexion Internet." });
      if (bad && r.response === 0 && (await askUpdateToken())) runCheck(true);
    }
  }
}
function setupUpdates() {
  if (!app.isPackaged) return;
  try {
    updater = require("electron-updater").autoUpdater;
    updater.autoDownload = false;          // on demande d'abord à l'utilisateur
    updater.autoInstallOnAppQuit = false;
    updater.on("update-available", info => { proposeUpdate(info); });
    updater.on("download-progress", p => {
      win.setProgressBar(p.percent / 100);
      win.setTitle(`AGOA CCTP — téléchargement de la mise à jour… ${Math.round(p.percent)} %`);
    });
    updater.on("update-downloaded", () => {
      updateState = "ready"; win.setProgressBar(-1);
      js("window.__agoaSaveNow ? window.__agoaSaveNow() : null").catch(() => {})
        .then(() => js("typeof Store !== 'undefined' && Store.flush && Store.flush()")).catch(() => {}).finally(() => {
          allowClose = true;
          setTimeout(() => updater.quitAndInstall(true, true), 600); // installation silencieuse puis relance
        });
    });
    updater.on("error", err => { console.warn("Mise à jour :", err && err.message); });
    // Recherche au lancement, une fois la fenêtre affichée
    win.webContents.once("did-finish-load", () => setTimeout(() => runCheck(false), 2500));
  } catch (e) { console.warn(e); }
}

/* ---------- fenêtre ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    title: `AGOA CCTP — v${INFO.version}`, icon: path.join(__dirname, "build", "icon.ico"),
    autoHideMenuBar: false, backgroundColor: "#EEF0ED",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^(https?|mailto):/i.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("file:")) { e.preventDefault(); if (/^(https?|mailto):/i.test(url)) shell.openExternal(url); } });
  win.webContents.on("did-finish-load", () => { ready = true; if (pendingFile) { win.webContents.send("open-file", pendingFile.name, pendingFile.text, pendingFile.file); pendingFile = null; } });
  win.on("close", e => {
    if (allowClose) return;
    e.preventDefault();
    if (!closing) confirmClose();
  });
  win.loadFile(path.join(__dirname, "app", "index.html"));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Fichier", submenu: [{ label: "Ouvrir un fichier .cctp…", accelerator: "CmdOrCtrl+O", click: () => openDialog() }, { type: "separator" }, { role: "quit", label: "Quitter" }] },
    { label: "Affichage", submenu: [{ role: "reload", label: "Recharger" }, { role: "zoomIn", label: "Zoom +" }, { role: "zoomOut", label: "Zoom −" }, { role: "resetZoom", label: "Zoom 100 %" }, { type: "separator" }, { role: "toggleDevTools", label: "Outils de développement" }] },
    { label: "Aide", submenu: [
      { label: `AGOA CCTP v${INFO.version} — déploiement n°${INFO.deploiement}`, enabled: false },
      { type: "separator" },
      { label: "Rechercher des mises à jour…", click: () => runCheck(true) },
      { label: "Accès aux mises à jour (jeton GitHub)…", click: async () => { if (await askUpdateToken()) runCheck(true); } },
      { label: "Clé API Ragic…", click: () => askRagicKey() }
    ] }
  ]));
}

/* ---------- confirmation de fermeture ---------- */
const js = code => win.webContents.executeJavaScript(code, true);
async function confirmClose() {
  closing = true;
  try {
    const info = await js("window.__agoaCloseInfo ? window.__agoaCloseInfo() : null").catch(() => null);
    if (info && info.fichier && !info.dirty) { allowClose = true; win.close(); return; }
    let buttons, detail, actions;
    if (info && info.fichier) {
      buttons = ["Enregistrer et fermer", "Fermer sans enregistrer", "Annuler"]; actions = ["save", "close", "cancel"];
      detail = `L'affaire ${info.code} sera enregistrée dans :\n${info.fichier}`;
    } else if (info) {
      buttons = ["Enregistrer le fichier .cctp et fermer", "Fermer sans fichier .cctp", "Annuler"]; actions = ["saveas", "close", "cancel"];
      detail = `L'affaire ${info.code} n'a pas encore de fichier .cctp sur le disque.\nSes données restent enregistrées dans l'application.`;
    } else {
      allowClose = true; win.close(); return;
    }
    const r = await dialog.showMessageBox(win, { type: "question", buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true, title: "Fermer AGOA CCTP", message: "Voulez-vous fermer AGOA CCTP ?", detail });
    const act = actions[r.response];
    if (act === "cancel") return;
    if (act === "save") await js("window.__agoaSaveNow()");
    if (act === "saveas") { const ok = await js("window.__agoaSaveAsNow()"); if (!ok) return; }
    if (act === "close") await js("typeof Store !== 'undefined' && Store.flush && Store.flush()").catch(() => {});
    allowClose = true; win.close();
  } catch (err) {
    const r = await dialog.showMessageBox(win, { type: "warning", buttons: ["Fermer quand même", "Annuler"], defaultId: 1, cancelId: 1, title: "Fermer AGOA CCTP", message: "L'enregistrement du fichier .cctp a échoué.", detail: String(err && err.message || err) });
    if (r.response === 0) { allowClose = true; win.close(); }
  } finally { closing = false; }
}
async function openDialog() {
  const r = await dialog.showOpenDialog(win, { title: "Ouvrir une affaire", defaultPath: app.getPath("documents"), properties: ["openFile"],
    filters: [{ name: "Affaire AGOA CCTP", extensions: ["cctp", "dce"] }, { name: "Tous les fichiers", extensions: ["*"] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const file = r.filePaths[0];
  return { name: path.basename(file), text: fs.readFileSync(file, "utf8"), file };
}

/* ---------- IPC ---------- */
ipcMain.on("info", e => { e.returnValue = INFO; });
ipcMain.on("load-data", e => { e.returnValue = readJson(dataPath(), {}); });
ipcMain.on("save-data", (e, text) => { try { writeAtomic(dataPath(), text); } catch (err) { console.error(err); } });
ipcMain.on("get-config", e => { e.returnValue = readJson(configPath(), {}); });
ipcMain.on("set-config", (e, patch) => { writeAtomic(configPath(), JSON.stringify({ ...readJson(configPath(), {}), ...patch }, null, 2)); e.returnValue = true; });
ipcMain.handle("ragic", (e, tool, input) => ragic(tool, input));
ipcMain.handle("save-file", async (e, filename, bytes) => {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const names = { cctp: "Affaire AGOA CCTP", xlsx: "Classeur Excel", pdf: "PDF" };
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath("documents"), filename), filters: [{ name: names[ext] || ext.toUpperCase(), extensions: [ext] }, { name: "Tous les fichiers", extensions: ["*"] }] });
  if (r.canceled || !r.filePath) return false;
  fs.writeFileSync(r.filePath, Buffer.from(bytes));
  return true;
});
ipcMain.handle("save-as", async (e, filename, text) => {
  const r = await dialog.showSaveDialog(win, { title: "Enregistrer l'affaire", defaultPath: path.join(app.getPath("documents"), filename), filters: [{ name: "Affaire AGOA CCTP", extensions: ["cctp"] }] });
  if (r.canceled || !r.filePath) return null;
  writeAtomic(r.filePath, text);
  return r.filePath;
});
ipcMain.handle("write-file", async (e, file, text) => {
  if (!/\.(cctp|dce)$/i.test(file)) throw new Error("Seuls les fichiers .cctp peuvent être écrits");
  writeAtomic(file, text);
  return true;
});
ipcMain.handle("save-pdf", async (e, filename) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath("documents"), filename), filters: [{ name: "PDF", extensions: ["pdf"] }] });
  if (r.canceled || !r.filePath) return false;
  const pdf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
  fs.writeFileSync(r.filePath, pdf);
  shell.openPath(r.filePath);
  return true;
});
ipcMain.handle("check-updates", async () => { await runCheck(true); return "ok"; });
ipcMain.handle("open-dialog", () => openDialog());

/* ---------- démarrage ---------- */
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on("second-instance", (e, argv) => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } openAgoarv(agoarvFromArgs(argv)); });
  app.on("open-file", (e, file) => { e.preventDefault(); openAgoarv(file); });
  app.whenReady().then(() => { createWindow(); openAgoarv(agoarvFromArgs(process.argv)); setupUpdates(); });
  app.on("window-all-closed", () => app.quit());
}
