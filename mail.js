"use strict";
// Envoi de courriel SMTP (TLS implicite sur 465, ou STARTTLS sur 587) sans dépendance externe.
const tls = require("tls");
const net = require("net");

const b64 = b => Buffer.from(b).toString("base64");
const wrap = s => s.replace(/(.{76})/g, "$1\r\n");
const hdr = s => (/^[\x20-\x7e]*$/.test(s) ? s : "=?UTF-8?B?" + b64(s) + "?=");
const addr = a => String(a || "").trim();

function buildMime(msg) {
  const boundary = "agoa-" + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const to = [].concat(msg.to).map(addr).filter(Boolean);
  const lines = [
    "From: " + msg.from,
    "To: " + to.join(", "),
    "Subject: " + hdr(msg.subject || ""),
    "Date: " + new Date().toUTCString().replace("GMT", "+0000"),
    "Message-ID: <" + Date.now().toString(36) + Math.random().toString(36).slice(2) + "@agoa-cctp>",
    "MIME-Version: 1.0",
    "Content-Type: multipart/mixed; boundary=\"" + boundary + "\"",
    "",
    "--" + boundary,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap(b64(msg.text || "")),
  ];
  for (const f of msg.attachments || []) {
    const name = String(f.name || "fichier").replace(/["\r\n]/g, "_");
    lines.push("--" + boundary, "Content-Type: application/octet-stream; name=\"" + hdr(name) + "\"", "Content-Transfer-Encoding: base64",
      "Content-Disposition: attachment; filename=\"" + hdr(name) + "\"", "", wrap(b64(Buffer.from(f.bytes))));
  }
  lines.push("--" + boundary + "--", "");
  return lines.join("\r\n");
}

async function smtpSend(cfg, msg) {
  const insecure = !!cfg.insecure, port = Number(cfg.port) || 465, implicit = cfg.secure != null ? !!cfg.secure : port === 465;
  let sock = await new Promise((res, rej) => {
    const o = { host: cfg.host, port, servername: cfg.host, rejectUnauthorized: !insecure };
    const s = implicit ? tls.connect(o, () => res(s)) : net.connect({ host: cfg.host, port }, () => res(s));
    s.once("error", rej); s.setTimeout(30000, () => { s.destroy(); rej(new Error("Délai dépassé : serveur de messagerie injoignable")); });
  });
  let buf = ""; const waiters = [];
  const flush = () => {
    while (waiters.length) {
      const L = buf.split(/\r?\n/); let n = -1;
      for (let i = 0; i < L.length - 1; i++) { if (/^\d{3} /.test(L[i]) || /^\d{3}$/.test(L[i])) { n = i; break; } }
      if (n < 0) return;
      const rep = L.slice(0, n + 1).join("\n"); buf = L.slice(n + 1).join("\r\n");
      waiters.shift().res(rep);
    }
  };
  const onData = d => { buf += d.toString("utf8"); flush(); };
  const failAll = e => waiters.splice(0).forEach(w => w.rej(e));
  const attach = s => { s.on("data", onData); s.on("error", failAll); s.on("close", () => failAll(new Error("Connexion fermée par le serveur"))); };
  attach(sock);
  const reply = () => new Promise((res, rej) => { waiters.push({ res, rej }); flush(); });
  const send = async (line, ok) => { sock.write(line + "\r\n"); const r = await reply(); if (!ok.includes(+r.slice(0, 3))) throw new Error("Serveur de messagerie : " + r.split("\n").pop().trim()); return r; };
  try {
    const g = await reply(); if (!g.startsWith("220")) throw new Error("Serveur de messagerie : " + g.trim());
    let eh = await send("EHLO agoa-cctp", [250]);
    if (!implicit && /STARTTLS/i.test(eh)) {
      await send("STARTTLS", [220]);
      sock.removeAllListeners("data"); sock.removeAllListeners("close"); sock.removeAllListeners("error");
      sock = tls.connect({ socket: sock, servername: cfg.host, rejectUnauthorized: !insecure });
      await new Promise((res, rej) => { sock.once("secureConnect", res); sock.once("error", rej); });
      buf = ""; attach(sock);
      eh = await send("EHLO agoa-cctp", [250]);
    }
    if (cfg.user) await send("AUTH PLAIN " + b64("\0" + cfg.user + "\0" + cfg.pass), [235]);
    await send("MAIL FROM:<" + addr(msg.from).replace(/^.*<|>.*$/g, "") + ">", [250]);
    for (const a of [].concat(msg.to).map(addr).filter(Boolean)) await send("RCPT TO:<" + a + ">", [250, 251]);
    await send("DATA", [354]);
    sock.write(buildMime(msg) + "\r\n.\r\n");
    const r = await reply(); if (+r.slice(0, 3) !== 250) throw new Error("Serveur de messagerie : " + r.trim());
    try { await send("QUIT", [221]); } catch {}
    return true;
  } finally { try { sock.destroy(); } catch {} }
}
module.exports = { smtpSend, buildMime };
