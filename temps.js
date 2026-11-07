"use strict";
// Journal de temps partagé avec le launcher AGOA : une ligne JSON par créneau d'activité réelle
// ({ts, src, ref, sec}) dans <AGOA_HOME>\_temps\journal\<source>.jsonl. Le launcher regroupe ces temps par opération.
const fs = require("fs");
const path = require("path");

const pad = n => String(n).padStart(2, "0");
function localIso(d) {
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}
function journalDir() { return path.join(process.env.AGOA_HOME || "C:\\AGOA", "_temps", "journal"); }

function logTime(src, ref, sec) {
  sec = Math.round(Number(sec));
  if (!(sec > 0) || sec > 3600) return false;           // un créneau n'excède jamais une heure : valeur aberrante ignorée
  try {
    fs.mkdirSync(journalDir(), { recursive: true });
    fs.appendFileSync(path.join(journalDir(), src + ".jsonl"), JSON.stringify({ ts: localIso(new Date()), src, ref: String(ref || ""), sec }) + "\n");
    return true;
  } catch { return false; }
}
module.exports = { logTime, localIso };
