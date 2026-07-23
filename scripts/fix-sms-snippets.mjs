// fix-sms-snippets.mjs — compliance-scrub the non-compliant SMS snippet TEMPLATES.
// Surgical word-swap that NEVER touches text inside {{...}} merge fields.
//
// SAFE: dry-run by default (before->after preview, no writes). --apply writes live.
//   Read:  GET  https://backend.leadconnectorhq.com/locations/{loc}/templates?type=sms
//   Write: PUT  https://backend.leadconnectorhq.com/locations/{loc}/templates/{id}   body {name, template}
//
// On --apply it: (1) runs a NO-OP write on one template + re-reads to prove the
// endpoint is safe before touching anything else, (2) skips any template whose
// merge fields would change, (3) re-reads each after writing to verify, (4) saves
// rollback backups to /tmp/sms-backups.json.
//
// Usage:
//   node scripts/fix-sms-snippets.mjs                        # dry-run (from /tmp/sms-templates.json if no token)
//   GHL_WEB_TOKEN='eyJ...' node scripts/fix-sms-snippets.mjs # dry-run against live
//   GHL_WEB_TOKEN='eyJ...' node scripts/fix-sms-snippets.mjs --apply

import fs from "fs";
const LOC = process.env.GHL_LOCATION_ID || "ORh91GeY4acceSASSnLR";
const TOK = process.env.GHL_WEB_TOKEN;
const APPLY = process.argv.includes("--apply");
const UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36";
const H = () => ({ Authorization: `Bearer ${TOK}`, channel: "APP", source: "WEB_USER", accept: "application/json, text/plain, */*", "content-type": "application/json", origin: "https://app.gohighlevel.com", referer: "https://app.gohighlevel.com/", "User-Agent": UA, version: "2021-07-28" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MAP = [
  [/credit reports?/gi, "financial profile"], [/credit repair/gi, "profile optimization"], [/credit scores?/gi, "financial profile"],
  [/lenders/gi, "partner banks"], [/lender/gi, "partner bank"], [/bureaus/gi, "agencies"], [/bureau/gi, "agency"],
  [/disputes/gi, "correction requests"], [/dispute/gi, "correction request"], [/funding/gi, "capital"], [/\bfund\b/gi, "capital"]
];
const cl = (s, r) => (s === s.toUpperCase() ? r.toUpperCase() : s[0] === s[0].toUpperCase() ? r[0].toUpperCase() + r.slice(1) : r);
const scrub = (b) => b.split(/(\{\{[^}]*\}\})/g).map((p, i) => (i % 2 ? p : MAP.reduce((s, [re, r]) => s.replace(re, (m) => cl(m, r)), p))).join("");
const mf = (s) => (s.match(/\{\{[^}]*\}\}/g) || []).sort().join("|");
const bad = /\b(lenders?|funding|fund|credit repair|credit reports?|credit scores?|disputes?|bureaus?)\b/i;

const listAll = async () => ((await (await fetch(`https://backend.leadconnectorhq.com/locations/${LOC}/templates?type=sms&limit=500`, { headers: H() })).json()).templates || []);
const putTmpl = (id, name, tmpl) => fetch(`https://backend.leadconnectorhq.com/locations/${LOC}/templates/${id}`, { method: "PUT", headers: H(), body: JSON.stringify({ name, template: tmpl }) });

async function main() {
  if (APPLY && !TOK) { console.error("GHL_WEB_TOKEN required for --apply."); process.exit(1); }

  let all;
  if (TOK) all = await listAll();
  else { console.log("(dry-run from /tmp/sms-templates.json)"); all = JSON.parse(fs.readFileSync("/tmp/sms-templates.json", "utf8")).map((x) => ({ id: x.id, name: x.name, template: { body: x.body } })); }

  if (APPLY) {
    // NO-OP SAFETY GATE: write one template back identically, re-read, must be unchanged.
    const g = all.find((x) => /F03-01/.test(x.name)) || all[0];
    const before = g.template.body;
    const r = await putTmpl(g.id, g.name, g.template);
    await sleep(400);
    const after = (await listAll()).find((x) => x.id === g.id).template.body;
    if (!(r.ok && after === before)) { console.log(`NO-OP GATE FAILED (status ${r.status}, unchanged ${after === before}) — aborting, nothing written.`); process.exit(1); }
    console.log("NO-OP GATE PASSED — endpoint safe.\n");
  }

  const backups = {}; let ok = 0, skip = 0, todo = 0;
  for (const t of all) {
    const body = t.template?.body || "";
    if (!bad.test(body)) continue;
    const next = scrub(body);
    if (next === body) continue;
    if (mf(next) !== mf(body)) { console.log(`SKIP ${t.name} — merge-field mismatch`); skip++; continue; }
    todo++;
    console.log(`\n=== ${t.name} (${t.id}) ===`);
    console.log("BEFORE: " + body.replace(/\s+/g, " "));
    console.log("AFTER : " + next.replace(/\s+/g, " "));
    if (APPLY) {
      backups[t.id] = { name: t.name, body };
      const r = await putTmpl(t.id, t.name, { ...t.template, body: next });
      await sleep(400);
      const verify = (await listAll()).find((x) => x.id === t.id).template.body;
      const good = r.ok && verify === next;
      console.log(good ? "  written + verified" : `  FAILED status ${r.status}, verify mismatch`);
      if (good) ok++;
    }
  }
  if (APPLY) { fs.writeFileSync("/tmp/sms-backups.json", JSON.stringify(backups, null, 2)); console.log(`\n=== ${ok}/${todo} fixed, ${skip} skipped. Rollback backups -> /tmp/sms-backups.json ===`); }
  else console.log(`\n=== DRY-RUN: ${todo} templates would change, ${skip} skipped. Apply: GHL_WEB_TOKEN=... node scripts/fix-sms-snippets.mjs --apply ===`);
}
main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
