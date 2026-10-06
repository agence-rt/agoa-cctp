// Prépare un nouveau déploiement : incrémente le numéro, aligne la version,
// met à jour l'interface, puis crée le commit. GitHub Actions publie la Release
// (et son étiquette vX.Y.Z) dès que la nouvelle version arrive sur main.
// Usage : npm run deploy -- "Description de la mise à jour"
"use strict";
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const root = path.join(__dirname, "..");
const pkgPath = path.join(root, "package.json");
const htmlPath = path.join(root, "app", "index.html");
const logPath = path.join(root, "DEPLOIEMENTS.md");

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const n = (pkg.agoa.deploiement || 0) + 1;
const version = `0.${n}.0`;
const note = process.argv.slice(2).join(" ").trim() || "Mise à jour";

pkg.agoa.deploiement = n;
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

let html = fs.readFileSync(htmlPath, "utf8");
html = html.replace(/(const APP = \{[^}]*version: )"[^"]*"(, deploiement: )\d+/, `$1"${version}"$2${n}`);
fs.writeFileSync(htmlPath, html);

const date = new Date().toISOString().slice(0, 10);
const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "# Déploiements AGOA CCTP\n\n";
fs.writeFileSync(logPath, log.replace(/(# Déploiements AGOA CCTP\n\n)/, `$1- **n°${n}** — v${version} — ${date} — ${note}\n`));

// Notes affichées dans la fenêtre « Mise à jour disponible » (lues par electron-builder)
fs.writeFileSync(path.join(root, "build", "release-notes.md"), `Déploiement n°${n} — ${note}\n`);

const sh = c => execSync(c, { cwd: root, stdio: "inherit" });
sh("git add -A");
sh(`git commit -m "Déploiement n°${n} (v${version}) : ${note.replace(/"/g, "'")}"`);
console.log(`\nDéploiement n°${n} prêt (v${version}). Envoyez-le avec : git push`);
