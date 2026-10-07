"use strict";
// AGOA CCTP — processus principal Electron
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");

const pkg = require("./package.json");
const INFO = { version: pkg.version, deploiement: (pkg.agoa && pkg.agoa.deploiement) || 0 };

let win = null;
let pendingFile = null; // fichier .cctp à ouvrir dès que l'interface est prête
let ready = false;
let allowClose = false;   // vrai une fois la fermeture confirmée (ou pendant une mise à jour)
let closing = false;
let booting = true;       // vrai tant que la fenêtre principale n'est pas créée (écran de démarrage, connexion)

/* ---------- fichiers de données (dans %APPDATA%\AGOA CCTP) ---------- */
const userDir = () => app.getPath("userData");
const dataPath = () => path.join(userDir(), "agoa-cctp-donnees.json");
const configPath = () => path.join(userDir(), "agoa-cctp-config.json");

function readJson(p, def) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return def; } }
function writeAtomic(p, text, bak = true) {
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, text, "utf8");
  if (bak && fs.existsSync(p)) fs.copyFileSync(p, p + ".bak"); // copie de secours de la version précédente
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

/* ---------- mises à jour (Releases GitHub du dépôt agence-rt/agoa-cctp) ---------- */
// Le dépôt est privé : chaque poste a besoin d'un jeton GitHub en lecture seule (Contents : Read)
// enregistré une fois via Aide, « Accès aux mises à jour ».
const REPO = { owner: "agence-rt", repo: "agoa-cctp" };
let updater = null;
let updateState = "idle"; // idle | checking | proposed | downloading | ready
let manualCheck = false;
let phase = "splash";      // splash | running
let startupDone = null;    // résout le contrôle de démarrage
let pendingVersion = "";
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
  const token = getSecret("githubToken"); // facultatif : seulement si le dépôt redevient privé
  if (token) updater.setFeedURL({ provider: "github", owner: REPO.owner, repo: REPO.repo, private: true, token, releaseType: "release" });
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
  applyFeed();
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
function initUpdater() {
  if (!app.isPackaged) return;
  try {
    updater = require("electron-updater").autoUpdater;
    updater.autoDownload = true;           // mise à jour automatique : téléchargement puis installation sans question
    updater.autoInstallOnAppQuit = true;
    applyFeed();
    updater.on("update-available", info => {
      if (updateState === "downloading" || updateState === "ready") return;
      updateState = "downloading"; pendingVersion = info.version;
      if (phase === "splash") splashStatus(`Mise à jour ${info.version} disponible — téléchargement…`, 0);
      else if (win) win.setTitle(`AGOA CCTP — mise à jour ${info.version} en cours de téléchargement…`);
    });
    updater.on("update-not-available", () => { if (phase === "splash" && startupDone) startupDone("none"); });
    updater.on("download-progress", p => {
      if (phase === "splash") splashStatus(`Téléchargement de la mise à jour ${pendingVersion}… ${Math.round(p.percent)} %`, p.percent);
      else if (win) { win.setProgressBar(p.percent / 100); win.setTitle(`AGOA CCTP — téléchargement de la mise à jour… ${Math.round(p.percent)} %`); }
    });
    updater.on("update-downloaded", () => {
      updateState = "ready";
      const msg = `Installation de la version ${pendingVersion}… AGOA CCTP va redémarrer`;
      // L'écran AGOA reste affiché jusqu'à la fermeture de l'application pour l'installation (silencieuse), puis relance.
      const install = () => {
        allowClose = true;
        if (win && !win.isDestroyed()) win.hide();
        if (!splash) { showSplash(); splashLoaded.then(() => splashStatus(msg, 100)); }
        setTimeout(() => updater.quitAndInstall(true, true), 2500);
      };
      if (phase === "splash") { splashStatus(msg, 100); install(); return; }
      if (win) win.setProgressBar(-1);
      js("window.__agoaSaveQuiet ? window.__agoaSaveQuiet() : null").catch(() => {})
        .then(() => js("typeof Store !== 'undefined' && Store.flush && Store.flush()")).catch(() => {}).finally(install);
    });
    updater.on("error", err => {
      console.warn("Mise à jour :", err && err.message);
      if (updateState === "checking") updateState = "idle";
      if (phase === "splash" && updateState !== "downloading" && startupDone) { startupDone("none"); return; }
      if (updateState !== "downloading" && updateState !== "ready") updateState = "idle";
      if (win && !win.isDestroyed()) { win.setProgressBar(-1); win.setTitle(`AGOA CCTP — v${INFO.version}`); }
    });
    setInterval(() => runCheck(false), 4 * 3600 * 1000);  // puis toutes les 4 heures en cours d'utilisation
  } catch (e) { console.warn(e); updater = null; }
}
// Pendant l'écran de démarrage : recherche, puis téléchargement/installation/relance si une version plus récente existe.
function startupUpdateCheck() {
  if (!updater) return Promise.resolve("none");
  return new Promise(resolve => {
    let done = false;
    startupDone = r => { if (!done) { done = true; resolve(r); } };
    splashStatus("Recherche de mise à jour…");
    updateState = "checking";
    // Hors connexion ou GitHub lent : on démarre au bout de 6 s (sauf si un téléchargement a commencé)
    setTimeout(() => { if (updateState !== "downloading" && updateState !== "ready") startupDone("none"); }, 6000);
    updater.checkForUpdates().then(r => { if (r && r.isUpdateAvailable === false) startupDone("none"); }).catch(() => startupDone("none"));
  }).then(r => { if (updateState === "checking") updateState = "idle"; return r; });
}

/* ---------- écran de démarrage (logo AGOA : app/splash-logo.png) ---------- */
let splash = null, splashAt = 0, splashLoaded = null;
function showSplash() {
  splashAt = Date.now();
  splash = new BrowserWindow({ width: 520, height: 320, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
    alwaysOnTop: true, center: true, show: false, skipTaskbar: true, backgroundColor: "#ffffff", icon: path.join(__dirname, "build", "icon.ico"),
    webPreferences: { contextIsolation: true, nodeIntegration: false } });
  splashLoaded = new Promise(res => splash.webContents.once("did-finish-load", res));
  splash.once("ready-to-show", () => splash && splash.show());
  splash.loadFile(path.join(__dirname, "app", "splash.html"), { query: { v: INFO.version } });
  splash.on("closed", () => { splash = null; });
}
function splashStatus(text, pct = null) {
  if (!splash || splash.isDestroyed()) return;
  splash.webContents.executeJavaScript(`window.setStatus && setStatus(${JSON.stringify(text)}, ${pct == null ? "null" : Math.round(pct)})`).catch(() => {});
}
function closeSplash() { if (splash && !splash.isDestroyed()) splash.close(); splash = null; }
function endSplash() {
  const wait = Math.max(0, 2200 - (Date.now() - splashAt));  // l'écran reste au moins 2,2 s
  setTimeout(() => {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); }
    closeSplash(); phase = "running";
  }, wait);
}

/* ---------- accès réservé : identification Google (même client OAuth qu'AGOA PV) ---------- */
// Réglages dans package.json → agoa.google : { clientId, clientSecret (injecté à la fabrication), allowed: [sha256(e-mail en minuscules)] }
const GOOGLE = (pkg.agoa && pkg.agoa.google) || {};
const authEnabled = () => !!(GOOGLE.clientId && Array.isArray(GOOGLE.allowed) && GOOGLE.allowed.length);
const sha256 = s => crypto.createHash("sha256").update(String(s).trim().toLowerCase()).digest("hex");
const b64url = buf => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function readAuth() {
  try {
    const enc = readJson(configPath(), {}).auth;
    if (!enc || !safeStorage.isEncryptionAvailable()) return null;
    return JSON.parse(safeStorage.decryptString(Buffer.from(enc, "base64")));
  } catch { return null; }
}
function writeAuth(obj) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Chiffrement Windows indisponible");
  const enc = safeStorage.encryptString(JSON.stringify(obj)).toString("base64"); // lié à la session Windows (DPAPI)
  writeAtomic(configPath(), JSON.stringify({ ...readJson(configPath(), {}), auth: enc }, null, 2));
}
const isAllowed = email => !!email && GOOGLE.allowed.includes(sha256(email));
function authPage(ok, msg) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>AGOA CCTP</title><style>body{font-family:"Segoe UI",Arial,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fff;color:#1F2328}div{text-align:center}b{display:inline-flex;width:84px;height:84px;border-radius:16px;background:#B3261E;color:#fff;align-items:center;justify-content:center;font-size:22px}h1{font-size:20px;letter-spacing:.12em;margin:18px 0 8px}p{color:#666}</style></head><body><div><b>AGOA</b><h1>AGOA <span style="color:#B3261E">CCTP</span></h1><p>${ok ? "Identification terminée. Vous pouvez fermer cet onglet et revenir dans AGOA CCTP." : "Identification interrompue : " + msg}</p></div></body></html>`;
}
async function googleSignIn() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const server = http.createServer();
  await new Promise((res, rej) => { server.once("error", rej); server.listen(0, "127.0.0.1", res); });
  const redirect = `http://127.0.0.1:${server.address().port}`;
  try {
    const code = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Délai dépassé (5 minutes).")), 5 * 60 * 1000);
      server.on("request", (req, resp) => {
        const u = new URL(req.url, redirect);
        if (u.pathname !== "/") { resp.writeHead(404); resp.end(); return; }
        const err = u.searchParams.get("error"), c = u.searchParams.get("code"), st = u.searchParams.get("state");
        const ok = !err && c && st === state;
        resp.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        resp.end(authPage(ok, err === "access_denied" ? "accès refusé." : (err || "réponse invalide.")));
        clearTimeout(t);
        if (ok) resolve(c); else reject(new Error(err === "access_denied" ? "Connexion annulée." : "Réponse de Google invalide."));
      });
      const q = new URLSearchParams({ client_id: GOOGLE.clientId, redirect_uri: redirect, response_type: "code", scope: "openid email",
        code_challenge: challenge, code_challenge_method: "S256", state, prompt: "select_account" });
      shell.openExternal("https://accounts.google.com/o/oauth2/v2/auth?" + q);
    });
    const body = new URLSearchParams({ code, client_id: GOOGLE.clientId, redirect_uri: redirect, grant_type: "authorization_code", code_verifier: verifier });
    if (GOOGLE.clientSecret) body.set("client_secret", GOOGLE.clientSecret);
    const tok = await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body })).json();
    if (!tok.id_token) throw new Error("Google n'a pas renvoyé d'identité (" + (tok.error_description || tok.error || "erreur") + ").");
    const info = await (await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(tok.id_token))).json();
    if (info.aud !== GOOGLE.clientId || !/accounts\.google\.com$/.test(info.iss || "") || String(info.email_verified) !== "true") throw new Error("Identité Google non vérifiée.");
    return { email: info.email, sub: info.sub };
  } finally { server.close(); }
}
function askLogin() {
  return new Promise(resolve => {
    let settled = false;
    const done = v => { if (settled) return; settled = true; resolve(v); if (lw && !lw.isDestroyed()) lw.destroy(); };
    const lw = new BrowserWindow({ width: 520, height: 400, resizable: false, minimizable: true, maximizable: false, center: true, show: false,
      title: "AGOA CCTP — Connexion", icon: path.join(__dirname, "build", "icon.ico"), autoHideMenuBar: true, backgroundColor: "#FFFFFF",
      webPreferences: { preload: path.join(__dirname, "login-preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    lw.setMenu(null);
    lw.once("ready-to-show", () => lw.show());
    lw.on("closed", () => done(false));
    const onStart = async e => {
      if (e.sender !== lw.webContents) return;
      try {
        const id = await googleSignIn();
        if (lw.isDestroyed()) return;
        if (!isAllowed(id.email)) { lw.webContents.send("login-status", "err", `Le compte ${id.email} n'est pas autorisé à utiliser AGOA CCTP.`); return; }
        writeAuth({ email: id.email, sub: id.sub, le: new Date().toISOString() });
        lw.webContents.send("login-status", "ok", `Connecté : ${id.email}`);
        setTimeout(() => done(true), 900);
      } catch (err) { if (!lw.isDestroyed()) lw.webContents.send("login-status", "err", err.message || String(err)); }
      finally { if (!lw.isDestroyed()) lw.focus(); }
    };
    const onQuit = e => { if (e.sender === lw.webContents) done(false); };
    ipcMain.on("login-start", onStart); ipcMain.on("login-quit", onQuit);
    lw.on("closed", () => { ipcMain.removeListener("login-start", onStart); ipcMain.removeListener("login-quit", onQuit); });
    lw.loadFile(path.join(__dirname, "app", "login.html"));
  });
}
async function ensureAuthorized() {
  if (!authEnabled()) return true;
  const a = readAuth();
  if (a && isAllowed(a.email)) return true;
  closeSplash();
  const ok = await askLogin();
  if (ok) showSplash();   // on retrouve l'écran de démarrage jusqu'à l'ouverture de l'application
  return ok;
}

/* ---------- fenêtre ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    title: `AGOA CCTP — v${INFO.version}`, icon: path.join(__dirname, "build", "icon.ico"),
    autoHideMenuBar: false, backgroundColor: "#EEF0ED", show: false,
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
  win.once("ready-to-show", endSplash);
  setTimeout(() => { if (win && !win.isDestroyed() && !win.isVisible()) endSplash(); }, 20000); // sécurité : jamais bloqué sur l'écran de démarrage
  win.loadFile(path.join(__dirname, "app", "index.html"));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Fichier", submenu: [{ label: "Ouvrir un fichier .cctp…", accelerator: "CmdOrCtrl+O", click: () => openDialog() }, { type: "separator" }, { role: "quit", label: "Quitter" }] },
    { label: "Affichage", submenu: [{ role: "reload", label: "Recharger" }, { role: "zoomIn", label: "Zoom +" }, { role: "zoomOut", label: "Zoom −" }, { role: "resetZoom", label: "Zoom 100 %" }, { type: "separator" }, { role: "toggleDevTools", label: "Outils de développement" }] },
    { label: "Aide", submenu: [
      { label: `AGOA CCTP v${INFO.version} — déploiement n°${INFO.deploiement}`, enabled: false },
      ...(authEnabled() && readAuth() ? [{ label: `Compte : ${readAuth().email}`, enabled: false }] : []),
      { type: "separator" },
      { label: "Rechercher des mises à jour…", click: () => runCheck(true) },
      { label: "Bibliothèque partagée : choisir le dossier…", click: () => js("window.__libChoose && window.__libChoose()").catch(() => {}) },
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
ipcMain.on("save-data", (e, text) => {
  try {
    const old = readJson(dataPath(), null);
    if (old && Array.isArray(old.affaires) && old.v !== 2) { // ancien format : affaires copiées dans l'application, mises de côté une fois
      const keep = path.join(userDir(), "agoa-cctp-donnees-v1.json");
      if (!fs.existsSync(keep)) fs.copyFileSync(dataPath(), keep);
    }
    writeAtomic(dataPath(), text, false);
  } catch (err) { console.error(err); }
});
ipcMain.on("read-files", (e, paths) => {
  e.returnValue = (paths || []).map(p => {
    try { if (!/\.(cctp|dce)$/i.test(p)) return null; return { path: p, text: fs.readFileSync(p, "utf8") }; } catch { return null; }
  });
});

/* ---------- bibliothèque partagée (dossier Dropbox 09 - BDD / IA / AGOA-CCTP) ---------- */
const LIB_FILE = "bibliotheque-cctp.json";
function dropboxRoots() {
  const roots = [];
  for (const base of [process.env.LOCALAPPDATA, process.env.APPDATA]) {
    if (!base) continue;
    const info = readJson(path.join(base, "Dropbox", "info.json"), null);
    if (info) for (const k of Object.keys(info)) if (info[k] && info[k].path) roots.push(info[k].path);
  }
  const home = process.env.USERPROFILE || app.getPath("home");
  roots.push(path.join(home, "Dropbox"), home);
  return [...new Set(roots)].filter(r => { try { return fs.statSync(r).isDirectory(); } catch { return false; } });
}
const subdirs = d => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name); } catch { return []; } };
function findLibDir() {
  const cfg = readJson(configPath(), {});
  if (cfg.libDir && fs.existsSync(cfg.libDir)) return cfg.libDir;
  for (const root of dropboxRoots()) {
    const parents = [root, ...subdirs(root).filter(n => /^agence|t&k|thollet/i.test(n)).map(n => path.join(root, n))];
    for (const p of parents) {
      for (const bdd of subdirs(p).filter(n => /^09\b.*bdd/i.test(n))) {
        const d = path.join(p, bdd, "IA", "AGOA-CCTP");
        if (fs.existsSync(d)) return d;
      }
    }
  }
  return null;
}
const libFile = () => { const d = findLibDir(); return d ? path.join(d, LIB_FILE) : null; };
ipcMain.on("lib-state", e => {
  const d = findLibDir(); let mtime = 0;
  if (d) { try { mtime = fs.statSync(path.join(d, LIB_FILE)).mtimeMs; } catch {} }
  e.returnValue = d ? { dir: d, file: LIB_FILE, mtime } : null;
});
ipcMain.handle("lib-read", () => {
  const f = libFile(); if (!f) return null;
  try { return { text: fs.readFileSync(f, "utf8"), mtime: fs.statSync(f).mtimeMs }; } catch { return null; }
});
ipcMain.handle("lib-write", (e, text, expectedMtime) => {
  const f = libFile(); if (!f) throw new Error("Dossier de la bibliothèque introuvable");
  let cur = 0; try { cur = fs.statSync(f).mtimeMs; } catch {}
  if (cur && expectedMtime !== cur) return { conflict: true };   // un collègue vient de modifier le fichier
  writeAtomic(f, text, false);
  return { mtime: fs.statSync(f).mtimeMs };
});
ipcMain.handle("lib-choose", async () => {
  const r = await dialog.showOpenDialog(win, { title: "Choisir le dossier de la bibliothèque partagée (Dropbox : 09 - BDD / IA / AGOA-CCTP)", properties: ["openDirectory"] });
  if (r.canceled || !r.filePaths[0]) return null;
  writeAtomic(configPath(), JSON.stringify({ ...readJson(configPath(), {}), libDir: r.filePaths[0] }, null, 2), false);
  return r.filePaths[0];
});
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
  writeAtomic(r.filePath, text, false);
  return r.filePath;
});
ipcMain.handle("write-file", async (e, file, text) => {
  if (!/\.(cctp|dce)$/i.test(file)) throw new Error("Seuls les fichiers .cctp peuvent être écrits");
  writeAtomic(file, text, false);
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
  app.whenReady().then(async () => {
    showSplash(); initUpdater();
    await Promise.race([splashLoaded, new Promise(r => setTimeout(r, 3000))]);
    if (await startupUpdateCheck() === "updating") return;   // (l'application redémarre après installation)
    if (updateState === "downloading" || updateState === "ready") return;
    splashStatus("Vérification de l'accès…");
    if (!(await ensureAuthorized())) { allowClose = true; app.quit(); return; }
    splashStatus("Démarrage…");
    createWindow(); booting = false;
    openAgoarv(agoarvFromArgs(process.argv));
  });
  app.on("window-all-closed", () => { if (!booting) app.quit(); });
}
