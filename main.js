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
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function writeAtomic(p, text, bak = true) {
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, text, "utf8");
  if (bak && fs.existsSync(p)) { try { fs.copyFileSync(p, p + ".bak"); } catch {} } // copie de secours de la version précédente
  let err = null;
  for (let i = 0; i < 6; i++) {   // Dropbox ou l'antivirus verrouillent parfois le fichier un court instant
    try { fs.renameSync(tmp, p); return; }
    catch (e) { err = e; if (!/^(EPERM|EBUSY|EACCES)$/.test(e.code || "")) break; sleepSync(100 * (i + 1)); }
  }
  try { fs.writeFileSync(p, text, "utf8"); try { fs.unlinkSync(tmp); } catch {} }   // repli : écriture directe
  catch (e) { throw err || e; }
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

/* ---------- connexions partagées (AGOA Launcher > CONNEXIONS) : clé Ragic, clé Claude, compte Google ---------- */
const { readShared } = require("./shared");
let SHARED = {};
function sharedSecret(name) {   // en mémoire seulement : rien n'est recopié dans le fichier de configuration
  if (name === "ragicKey" && SHARED.ragic && SHARED.ragic.key) return SHARED.ragic.key;
  if (name === "anthropicKey" && SHARED.anthropic && SHARED.anthropic.key) return SHARED.anthropic.key;
  return "";
}

/* ---------- secrets (clé Ragic, jeton GitHub) : chiffrés avec le compte Windows quand c'est possible ---------- */
function getSecret(name) {
  const sh = sharedSecret(name); if (sh) return sh;
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
  const host = SHARED.ragic && SHARED.ragic.host ? "https://" + String(SHARED.ragic.host).replace(/^https?:\/\//, "") : (c.ragicHost || "https://eu2.ragic.com");
  return { host: host.replace(/\/+$/, ""), key };
}
async function ragicGet(url, key) {
  let r;
  try { r = await fetch(url + (url.includes("?") ? "&" : "?") + "APIKey=" + encodeURIComponent(String(key).replace(/[^A-Za-z0-9+\/=_-]/g, ""))); }   // clé dans l'adresse : méthode documentée par Ragic pour une clé API seule
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
/* Clé IA commune : fichier chiffré à côté de la bibliothèque partagée (Dropbox de l'agence).
   Le chiffrement évite qu'elle apparaisse en clair ; il ne remplace pas le contrôle d'accès au dossier. */
const AI_KEY_FILE = "agoa-ia.cle";
const aiKeyFile = () => { const d = findLibDir(); return d ? path.join(d, AI_KEY_FILE) : null; };
const aiCryptoKey = () => crypto.scryptSync("agoa-cctp/ia/" + REPO.owner, "agoa-ia-v1", 32);
function readSharedAiKey() {
  const f = aiKeyFile(); if (!f) return "";
  try {
    const b = Buffer.from(fs.readFileSync(f, "utf8").trim(), "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", aiCryptoKey(), b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  } catch { return ""; }
}
function writeSharedAiKey(key) {
  const f = aiKeyFile(); if (!f) return false;
  if (!key) { try { fs.unlinkSync(f); } catch {} return true; }
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", aiCryptoKey(), iv);
  const enc = Buffer.concat([c.update(key, "utf8"), c.final()]);
  writeAtomic(f, Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64"), false);
  return true;
}
const aiKey = () => sharedSecret("anthropicKey") || readSharedAiKey() || getSecret("anthropicKey");
async function askAnthropicKey() {
  const shared = !!findLibDir();
  const v = await askSecret("Reformulation par IA", "Clé API Anthropic",
    "Clé API (console.anthropic.com, API Keys) utilisée par la baguette magique des outils de texte. " +
    (shared ? "Elle sera partagée avec toute l'agence : enregistrée, chiffrée, dans le dossier de la bibliothèque commune ; les autres postes n'ont rien à saisir. Laissez vide pour la supprimer. "
            : "Dossier commun introuvable : elle est conservée chiffrée sur ce poste uniquement. ") +
    "Seul le texte à reformuler est envoyé à Anthropic.");
  if (v === null) return false;
  const k = v.trim();
  if (shared && writeSharedAiKey(k)) { setSecret("anthropicKey", ""); return !!k; }
  setSecret("anthropicKey", k);
  return !!k;
}
const AI_BASE = "Tu es rédacteur de CCTP pour une agence d'architecture spécialisée dans les copropriétés parisiennes. Tu travailles sur la description d'un ouvrage de travaux. Conserve strictement le sens, les valeurs, quantités, unités, références normatives (DTU, NF…), noms de produits et sigles ; n'invente aucune information et ne supprime aucune exigence. Conserve la structure en paragraphes (un paragraphe par ligne) et les listes. Réponds uniquement par le texte réécrit, en français, sans commentaire, sans titre et sans guillemets.";
const AI_MODES = {
  reformuler: "Reformule le texte de manière claire, précise et professionnelle, dans le style prescriptif d'un CCTP.",
  corriger: "Corrige uniquement l'orthographe, la grammaire, la ponctuation et la typographie, sans modifier le style ni le contenu.",
  raccourcir: "Raccourcis le texte en gardant toutes les prescriptions utiles ; supprime les redondances et tournures inutiles.",
  prescriptif: "Réécris le texte dans un style strictement prescriptif et formel de CCTP (« L'entreprise devra… », « Les travaux comprennent… »), au présent ou au futur de l'obligation."
};
async function aiRewrite(text, mode) {
  const key = aiKey();
  if (!key) throw new Error("[no_key] Clé API Anthropic manquante");
  const c = readJson(configPath(), {});
  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: c.aiModel || "claude-sonnet-5-5", max_tokens: 4000,
        system: AI_BASE + " " + (AI_MODES[mode] || AI_MODES.reformuler), messages: [{ role: "user", content: String(text).slice(0, 20000) }] }) });
  } catch (e) { throw new Error("[network] " + e.message); }
  if (r.status === 401 || r.status === 403) throw new Error("[auth] Clé API Anthropic refusée");
  if (r.status === 429) throw new Error("[rate] Trop de requêtes, réessayez dans un instant");
  if (!r.ok) throw new Error("[tool_error] Anthropic HTTP " + r.status);
  const j = await r.json();
  const out = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  if (!out) throw new Error("[tool_error] Réponse vide");
  return out;
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
  if (SHARED.google && isAllowed(SHARED.google.email)) return true;   // compte déjà connecté dans AGOA Launcher
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
  // correction orthographique en français + menu clic droit (suggestions, ajout au dictionnaire, copier/coller)
  try { win.webContents.session.setSpellCheckerLanguages(["fr"]); } catch {}
  win.webContents.on("context-menu", (e, p) => {
    const wc = win.webContents, items = [];
    if (p.misspelledWord) {
      (p.dictionarySuggestions || []).slice(0, 6).forEach(s => items.push({ label: s, click: () => wc.replaceMisspelling(s) }));
      if (!(p.dictionarySuggestions || []).length) items.push({ label: "Aucune suggestion", enabled: false });
      items.push({ type: "separator" }, { label: "Ajouter « " + p.misspelledWord + " » au dictionnaire", click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, { type: "separator" });
    }
    if (p.isEditable) items.push({ role: "undo", label: "Annuler" }, { role: "redo", label: "Rétablir" }, { type: "separator" }, { role: "cut", label: "Couper" }, { role: "copy", label: "Copier" }, { role: "paste", label: "Coller" }, { role: "selectAll", label: "Tout sélectionner" });
    else if (p.selectionText) items.push({ role: "copy", label: "Copier" });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
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
      { label: "Clé API Ragic…", click: () => askRagicKey() },
      { label: "Clé API Anthropic partagée (reformulation IA)…", click: () => askAnthropicKey() }
    ] }
  ]));
}

/* ---------- confirmation de fermeture ---------- */
const js = code => win.webContents.executeJavaScript(code, true);
async function confirmClose() {
  closing = true;
  try {
    const info = await js("window.__agoaCloseInfo ? window.__agoaCloseInfo() : null").catch(() => null);
    if (info && info.fichier) { // l'affaire a un fichier .cctp : enregistrement automatique à la fermeture, sans question
      if (info.dirty) await js("window.__agoaSaveQuiet()");
      if (info.auto) {
        await js(`window.__agoaCloseToast && window.__agoaCloseToast(${JSON.stringify("✓ Sauvegarde automatique à la fermeture : " + info.code)})`).catch(() => {});
        await new Promise(r => setTimeout(r, 1400));
      }
      await js("typeof Store !== 'undefined' && Store.flush && Store.flush()").catch(() => {});
      allowClose = true; win.close(); return;
    }
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
/* ---------- dossier Dropbox « 02 - ETUDE / 03 - RETOUR ENTREPRISES » d'une opération ---------- */
const isDirP = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const subFind = (d, re) => subdirs(d).find(n => re.test(n));
function dbxRel(p) {   // chemin relatif à la racine Dropbox : identique d'un poste à l'autre
  const pp = path.resolve(p);
  for (const r of dropboxRoots()) { const rr = path.resolve(r); if (pp.toLowerCase().startsWith(rr.toLowerCase() + path.sep)) return "/" + pp.slice(rr.length + 1).split(path.sep).join("/"); }
  return p;
}
function dbxResolve(p) {
  p = String(p || "").trim(); if (!p) return null;
  for (const r of dropboxRoots()) { const c = path.join(r, p); if (isDirP(c)) return c; }
  return isDirP(p) ? p : null;
}
function dbxFindOp(ref) {
  const parts = String(ref || "").trim().toUpperCase().split("-"), imm = parts[0].trim(), lt = (parts[1] || "").trim();
  if (!imm) return null;
  for (const root of dropboxRoots()) {
    const parents = [root, ...subdirs(root).filter(n => /^agence|t&k|thollet/i.test(n)).map(n => path.join(root, n))];
    for (const p of parents) {
      const ops = subFind(p, /^01\b.*operations?/i); if (!ops) continue;
      const opsD = path.join(p, ops), cands = [];
      for (const g of subdirs(opsD)) { const gd = path.join(opsD, g), im = subdirs(gd).find(n => n.toUpperCase() === imm); if (im) cands.push(path.join(gd, im)); }
      const direct = subdirs(opsD).find(n => n.toUpperCase() === imm); if (direct) cands.push(path.join(opsD, direct));
      for (const imD of cands) {
        let opD = imD;
        if (lt) { const l = subdirs(imD).find(n => new RegExp("^" + lt + "\\s*[-–]", "i").test(n)); if (!l) continue; opD = path.join(imD, l); }
        const et = subFind(opD, /^02\b.*[eé]tude/i); if (!et) continue;
        const etD = path.join(opD, et), rt = subFind(etD, /^03\b.*retour/i), rtD = path.join(etD, rt || "03 - RETOUR ENTREPRISES");
        if (!rt) { try { fs.mkdirSync(rtD, { recursive: true }); } catch { return null; } }
        return rtD;
      }
    }
  }
  return null;
}
ipcMain.handle("dbx-find", (e, ref, saved) => {
  let d = dbxResolve(saved), auto = false;
  if (!d) { d = dbxFindOp(ref); auto = !!d; }
  return d ? { dir: d, rel: dbxRel(d), auto } : null;
});
ipcMain.handle("dbx-choose", async () => {
  const r = await dialog.showOpenDialog(win, { title: "Choisir le dossier « 03 - RETOUR ENTREPRISES » de l'opération", defaultPath: dropboxRoots()[0], properties: ["openDirectory", "createDirectory"] });
  if (r.canceled || !r.filePaths[0]) return null;
  return { dir: r.filePaths[0], rel: dbxRel(r.filePaths[0]), auto: false };
});
ipcMain.handle("dbx-write", (e, dir, sub, files) => {
  if (!dir || !isDirP(dir)) throw new Error("Dossier de dépôt introuvable");
  const clean = s => String(s || "").replace(/[\\/:*?"<>|]+/g, "-").replace(/\.+$/, "").trim();
  const d = path.join(dir, clean(sub) || "Entreprise"); fs.mkdirSync(d, { recursive: true });
  const out = [];
  for (const f of files || []) { const n = clean(f.name); if (!n) continue; fs.writeFileSync(path.join(d, n), Buffer.from(f.bytes)); out.push(n); }
  return { dir: d, files: out };
});
/* ---------- surveillance du dossier retour + messagerie ---------- */
const { smtpSend } = require("./mail");
ipcMain.handle("dbx-scan", (e, dir) => {
  if (!dir || !isDirP(dir)) return [];
  const out = [];
  const walk = (d, rel, depth) => {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const x of es) {
      if (x.name.startsWith("~$") || x.name.startsWith(".")) continue;
      const p = path.join(d, x.name);
      if (x.isDirectory()) { if (depth < 2) walk(p, rel + x.name + "/", depth + 1); }
      else if (/\.(xlsx|xlsm|xls|ods)$/i.test(x.name)) { try { const st = fs.statSync(p); out.push({ rel: rel + x.name, name: x.name, sub: rel.replace(/\/$/, ""), size: st.size, mtime: st.mtimeMs }); } catch {} }
    }
  };
  walk(dir, "", 0); return out;
});
ipcMain.handle("dbx-read", (e, dir, rel) => {
  const base = path.resolve(dir), p = path.resolve(base, ...String(rel).split("/"));
  if (!p.toLowerCase().startsWith(base.toLowerCase() + path.sep)) throw new Error("Chemin refusé");
  return fs.readFileSync(p);
});
const mailCfg = () => { const c = readJson(configPath(), {}); return { host: c.mailHost || "", port: Number(c.mailPort) || 465, user: c.mailUser || "", from: c.mailFrom || c.mailUser || "", to: c.mailTo || "etudes@remithollet.fr", auto: c.mailAuto !== false, pass: getSecret("mailPass") }; };
ipcMain.handle("mail-get", () => { const m = mailCfg(); return { host: m.host, port: m.port, user: m.user, from: m.from, to: m.to, auto: m.auto, hasPass: !!m.pass, configured: !!(m.host && m.user && m.pass) }; });
ipcMain.handle("mail-set", (e, o, pass) => {
  const c = readJson(configPath(), {});
  c.mailHost = String(o.host || "").trim(); c.mailPort = Number(o.port) || 465; c.mailUser = String(o.user || "").trim();
  c.mailFrom = String(o.from || "").trim(); c.mailTo = String(o.to || "").trim() || "etudes@remithollet.fr"; c.mailAuto = !!o.auto;
  writeAtomic(configPath(), JSON.stringify(c, null, 2));
  if (pass) setSecret("mailPass", pass);
  return true;
});
ipcMain.handle("mail-send", async (e, msg) => {
  const m = mailCfg(); if (!(m.host && m.user && m.pass)) return { ok: false, reason: "config" };
  try { await smtpSend({ host: m.host, port: m.port, user: m.user, pass: m.pass }, { from: m.from || m.user, to: (msg.to || m.to).split(/[;,\s]+/).filter(Boolean), subject: msg.subject, text: msg.text, attachments: (msg.attachments || []).map(a => ({ name: a.name, bytes: Buffer.from(a.bytes) })) }); return { ok: true, to: msg.to || m.to }; }
  catch (err) { return { ok: false, reason: "error", message: err && err.message || "erreur" }; }
});
ipcMain.handle("mail-draft", (e, to, subject, body) => { shell.openExternal("mailto:" + encodeURIComponent(to) + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(String(body).slice(0, 1800))); return true; });
/* sauvegardes versionnées locales (dans le profil de l'application, hors Dropbox) */
const bkDir = id => path.join(app.getPath("userData"), "sauvegardes", String(id).replace(/[^\w.-]+/g, "_"));
const bkStrip = t => String(t).replace(/"enregistre_le":\s*"[^"]*"/, "");
ipcMain.on("whoami", e => { try { e.returnValue = require("os").userInfo().username; } catch { e.returnValue = ""; } });
ipcMain.handle("bk-write", (e, id, text) => {
  const d = bkDir(id); fs.mkdirSync(d, { recursive: true });
  const files = fs.readdirSync(d).filter(f => f.endsWith(".cctp")).sort();
  if (files.length && bkStrip(fs.readFileSync(path.join(d, files[files.length - 1]), "utf8")) === bkStrip(text)) return false;
  fs.writeFileSync(path.join(d, new Date().toISOString().replace(/[:.]/g, "-") + ".cctp"), text);
  const all = fs.readdirSync(d).filter(f => f.endsWith(".cctp")).sort();
  while (all.length > 20) { try { fs.unlinkSync(path.join(d, all.shift())); } catch { break; } }
  return true;
});
ipcMain.handle("bk-list", (e, id) => {
  const d = bkDir(id); if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter(f => f.endsWith(".cctp")).sort().reverse().map(f => { const st = fs.statSync(path.join(d, f)); return { file: f, t: st.mtimeMs, size: st.size }; });
});
ipcMain.handle("bk-read", (e, id, file) => fs.readFileSync(path.join(bkDir(id), path.basename(file)), "utf8"));
ipcMain.on("get-config", e => { e.returnValue = readJson(configPath(), {}); });
ipcMain.on("set-config", (e, patch) => { writeAtomic(configPath(), JSON.stringify({ ...readJson(configPath(), {}), ...patch }, null, 2)); e.returnValue = true; });
ipcMain.handle("ragic", (e, tool, input) => ragic(tool, input));
ipcMain.handle("ai-rewrite", (e, text, mode) => aiRewrite(text, mode));
ipcMain.handle("ai-key", () => askAnthropicKey());
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
    SHARED = await readShared();
    if (!(await ensureAuthorized())) { allowClose = true; app.quit(); return; }
    splashStatus("Démarrage…");
    createWindow(); booting = false;
    openAgoarv(agoarvFromArgs(process.argv));
  });
  app.on("window-all-closed", () => { if (!booting) app.quit(); });
}
