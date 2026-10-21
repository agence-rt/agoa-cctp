"use strict";
/* Connexions partagées AGOA : clés saisies une fois dans AGOA Launcher (bouton CONNEXIONS).
   Lecture : fichier chiffré DPAPI C:\AGOA\_connexions\connexions.dat (toujours à jour), à défaut variables d'environnement
   AGOA_* transmises par le launcher. Format : { ragic:{key,host}, google:{refresh_token,email,name,scopes,client_id}, anthropic:{key} } */
const path = require("path");
const { execFile } = require("child_process");

function fromEnv(env) {
  const out = {};
  if (env.AGOA_RAGIC_KEY && env.AGOA_RAGIC_HOST) out.ragic = { key: env.AGOA_RAGIC_KEY, host: env.AGOA_RAGIC_HOST, apname: env.AGOA_RAGIC_APNAME || "agoa" };
  if (env.AGOA_GOOGLE_REFRESH_TOKEN && env.AGOA_GOOGLE_EMAIL) out.google = { refresh_token: env.AGOA_GOOGLE_REFRESH_TOKEN, email: env.AGOA_GOOGLE_EMAIL, client_id: env.AGOA_GOOGLE_CLIENT_ID || "" };
  if (env.AGOA_ANTHROPIC_API_KEY) out.anthropic = { key: env.AGOA_ANTHROPIC_API_KEY };
  return out;
}

const defaultFile = (env) => path.win32.join(env.AGOA_HOME || "C:\\AGOA", "_connexions", "connexions.dat");

function psRead(file, exec = execFile) {
  const cmd = "Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($env:AGOA_CONN_FILE),$null,'CurrentUser'))";
  return new Promise((resolve) => {
    exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], { windowsHide: true, timeout: 10000, env: Object.assign({}, process.env, { AGOA_CONN_FILE: file }) },
      (err, stdout) => { if (err) return resolve(null); try { resolve(JSON.parse(String(stdout).replace(/^\uFEFF/, ""))); } catch (e) { resolve(null); } });
  });
}

/** Retourne les connexions partagées ({} si aucune). Ne lève jamais d'erreur. */
async function readShared({ env = process.env, platform = process.platform, exec } = {}) {
  let file = null;
  if (platform === "win32") file = await psRead(defaultFile(env), exec);
  const e = fromEnv(env);
  return file && Object.keys(file).length ? Object.assign({}, e, file) : e;
}

module.exports = { readShared, fromEnv, defaultFile };
