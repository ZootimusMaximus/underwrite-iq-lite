// fix-messages.mjs — staged pusher for the blank/broken GHL workflow messages.
//
// SAFE BY DEFAULT: runs in DRY-RUN (read + show before→after diff, writes NOTHING).
// The write call is intentionally a stub — fill writeWorkflow() from ONE captured
// GHL builder save-request before enabling --apply. Never guess-write live workflows.
//
// Usage:
//   GHL_WEB_TOKEN='eyJ...' node scripts/fix-messages.mjs           # dry-run diff
//   GHL_WEB_TOKEN='eyJ...' node scripts/fix-messages.mjs --apply   # writes (only after writeWorkflow is wired)
//
// Read path is proven (same as ghl-crawl). Test on ONE workflow, verify, then the rest.

const TOKEN = process.env.GHL_WEB_TOKEN;
const LOC = process.env.GHL_LOCATION_ID || "ORh91GeY4acceSASSnLR";
const APPLY = process.argv.includes("--apply");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").split("=")[1]; // e.g. --only=F-03
const BACKEND = "https://backend.leadconnectorhq.com";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36";

const H = () => ({
  Authorization: `Bearer ${TOKEN}`,
  channel: "APP",
  source: "WEB_USER",
  accept: "application/json",
  origin: "https://app.gohighlevel.com",
  referer: "https://app.gohighlevel.com/",
  "User-Agent": UA,
  version: "2021-07-28"
});

// The corrected copy (from the Message Fix Worksheet). Match steps by type + name hint.
const FIXES = {
  "F-03": {
    id: "40fc2df8-ac2c-4c75-ae75-5ac598ecb95e",
    sms: "Hey {{contact.first_name}} — quick update ✅ Your application Round {{custom_fields.funding_round_number}} is submitted. Now our partner banks review (usually 24–72 hours). We'll text you the moment there's movement. Reply STOP to opt out.",
    emailSubject: "Update on your Round {{custom_fields.funding_round_number}} — it's submitted"
  },
  "F-04": {
    id: "79c4a7b9-5875-40b6-bfc4-fbbd5f740410",
    sms: "Hey {{contact.first_name}} — movement on Round {{custom_fields.funding_round_number}} ✅ We're reviewing partner bank decisions + terms now. We'll text your next step shortly. Reply STOP to opt out.",
    emailSubject: "Update on your Round {{custom_fields.funding_round_number}} — decisions are in"
  },
  "F-07": {
    id: "992e1734-3d5b-4d51-91cb-7b665650f407",
    sms: "Huge update {{contact.first_name}} — your capital is locked in ✅ Your next steps just hit your email from hello@fundhub.ai. Open it now so we can keep momentum. If you don't see it, check Promotions/Spam. Reply STOP to opt out.",
    emailSubject: "You're locked in — your next steps are inside 🎉"
  },
  "AX-07": {
    id: "286ad6d2-3738-4191-9bdc-71aa42a75c2b",
    sms: "Hey {{contact.first_name}} — we've briefly paused your file for a quick review to keep your approvals on track. Our team is on it and will reach out shortly. Questions? Reply HELP. Reply STOP to opt out."
  },
  "U-06": {
    id: "dff23d06-833e-422f-91f9-b9d909b49d80",
    // NOTE: replace the placeholder with the real analyzer URL before applying.
    sms: "Looks like your analyzer didn't finish — use this link to complete it now: {{custom_values.analyzer_entry_url}} Reply STOP to opt out."
  }
};

async function getJson(url, headers) {
  const r = await fetch(url, { headers: headers || {} });
  if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 80)}`);
  return r.json();
}

async function loadWorkflow(id) {
  const meta = await getJson(`${BACKEND}/workflow/${LOC}/${id}`, H());
  const w = meta.workflow || meta;
  const steps = w.fileUrl ? await getJson(w.fileUrl, { "User-Agent": UA }) : null;
  return { w, steps };
}

// STUB — fill from a captured GHL builder save-request (method, url, body shape).
// Until then, --apply refuses to run so we never guess-write a live workflow.
async function writeWorkflow(/* id, updatedSteps */) {
  throw new Error(
    "writeWorkflow() not wired yet — capture one GHL builder save-request (F12 → Network → edit an SMS step → Save) and implement the exact PUT/POST here before using --apply."
  );
}

const clip = (s, n = 90) => (s ? JSON.stringify(String(s).slice(0, n)) : "*** EMPTY ***");

async function main() {
  if (!TOKEN) {
    console.error("GHL_WEB_TOKEN required (browser WEB_USER token from the Workflows page).");
    process.exit(1);
  }
  const keys = Object.keys(FIXES).filter((k) => !ONLY || k === ONLY);
  console.log(`Mode: ${APPLY ? "APPLY (write)" : "DRY-RUN (no writes)"} · targets: ${keys.join(", ")}\n`);

  for (const key of keys) {
    const f = FIXES[key];
    try {
      const { w, steps } = await loadWorkflow(f.id);
      const tpl = (steps && steps.templates) || [];
      console.log(`=== ${key} — ${w.name} (${w.status}) ===`);
      let changed = false;
      for (const s of tpl) {
        const a = s.attributes || {};
        const ty = s.type || a.type;
        if (ty === "sms" && f.sms !== undefined) {
          console.log(`  SMS  before: ${clip(a.body)}`);
          console.log(`  SMS  after : ${clip(f.sms)}`);
          a.body = f.sms;
          changed = true;
        }
        if (ty === "email" && f.emailSubject !== undefined) {
          console.log(`  MAIL before subject: ${clip(a.subject)}`);
          console.log(`  MAIL after  subject: ${clip(f.emailSubject)}`);
          a.subject = f.emailSubject;
          changed = true;
        }
      }
      if (!changed) console.log("  (no matching SMS/email step found — check step names)");
      if (APPLY && changed) {
        await writeWorkflow(f.id, steps);
        console.log("  ✔ written");
      }
      console.log("");
    } catch (e) {
      console.log(`  ✗ ${key}: ${e.message}\n`);
    }
  }
  if (!APPLY) console.log("Dry-run only. Wire writeWorkflow() + rerun with --apply --only=F-03 to test one first.");
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
