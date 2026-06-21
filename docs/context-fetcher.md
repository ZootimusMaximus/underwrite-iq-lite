# Context Fetcher — Agent Context & Recall

Assembles a full-fidelity "chart" object for a contact at conversation time. A GHL
agent calls this live (once at conversation start), gets the contact's complete
file back, and uses it for that conversation.

Built per the **Agent Context and Recall Build Spec v2** (doctor/patient model:
Airtable is the full chart, GHL fields are the sticky note, no summaries).

---

## Endpoint

```
POST /api/lite/context-fetcher
Content-Type: application/json
```

### Request

```json
{
  "contactId": "GHL_CONTACT_ID",
  "behavioral": {                 // OPTIONAL — overrides the live GHL read
    "responsiveness": "fast|normal|slow",
    "friction_level": "high|medium|low",
    "primary_motivation": "speed|relief|growth|certainty|control"
  }
}
```

- `contactId` (required) — the GHL contact id. Matched against `CLIENTS.ghl_contact_id`.
- `behavioral` (optional) — if supplied, used as-is. If omitted, the Fetcher reads
  the 3 scores live from the GHL contact's custom fields
  (`customer_responsiveness`, `customer_friction_level`, `primary_motivation`).

### Response

`200` with `{ ok: true, chart: { ... } }`:

```json
{
  "ok": true,
  "chart": {
    "contact": {
      "name": "...", "email": "...", "phone": "...",
      "pipeline_stage": "...",
      "client_status": "lead|funding|repair|funded|past",
      "awareness_level": "L0|L1|L2|L3"
    },
    "credit": {
      "primary_fico": 0, "prequal_amount": 0, "preapproved_amount": 0,
      "recommendation": "funding|repair|disqualified",
      "utilization": "0%",
      "tradelines": [ ... ],
      "negatives": [ ... ],
      "optimization_suggestions": [ "CODE: problem — what to do next", ... ],
      "optimization_suggestions_complete": true
    },
    "files": [ { "type": "raw_report|bank_statement|dispute_letter|upload", "location": "url" } ],
    "funding_history": [ { "round": 1, "amount": 0, "outcome": "...", "date": "..." } ],
    "behavioral": { "responsiveness": "...", "friction_level": "...", "primary_motivation": "..." },
    "conversation": [ { "role": "contact|agent", "channel": "sms|email|dm", "text": "...", "ts": "..." } ]
  }
}
```

Errors:
- `400` — `contactId` missing.
- `404` — no `CLIENTS` record for that `contactId`.
- `405` — non-POST.
- `500` — Airtable not configured / unhandled error.

Notes:
- `optimization_suggestions_complete` is `true` when the full UnderwriteIQ findings
  are present (`latest_optimization_findings_full`), `false` when only the
  abbreviated `latest_top_fixes` is available.
- `conversation` is the full verbatim log from `CONVERSATION_MESSAGES`, sorted
  oldest→newest, with GHL internal-activity records (channel `other`) excluded.
- `behavioral` is `null` if not supplied and the GHL read fails (request never fails).

---

## Awareness levels

| Level | Trigger | Agent posture |
|---|---|---|
| L0 Cold | No soft pull (no FICO / no prequal) | Qualify, book, minimal assumptions |
| L1 Diagnosed | FICO + prequal present | Speak to their number, route funding vs repair |
| L2 Active | client_status = funding or repair | Continuity, drive the current step |
| L3 Returning | client_status = funded or past | Use history, pitch the next run |

---

## Data sources

- **Sticky note (GHL custom fields, instant read):** name, FICO, prequal, recommendation,
  client status, awareness level, and the 3 BC scores.
- **Full chart (Airtable, live pull):**
  - `CLIENTS` (keyed on `ghl_contact_id`) — identity, latest_* mirrors, file URLs
  - `SNAPSHOTS` — per-bureau scores, utilization, neg counts, raw report URLs
  - `FUNDING_ROUNDS` — round history + outcomes
  - `INQUIRY_LOG` — open inquiries
  - `PERSONAL_TRADELINES` / `BUSINESS_TRADELINES` — tradelines
  - `CONVERSATION_MESSAGES` (id `tblPL17FxHaZrCxt4`) — verbatim message archive, all channels

---

## Wiring into GHL agents (Task #6 — Chris)

Fire **once at conversation start** (refresh only if the thread runs long).

### Text channels — Conversation AI V3 Custom Webhook node
1. Add a **Custom Webhook** action node at the start of the agent flow.
2. Method `POST`, URL `https://<deploy-host>/api/lite/context-fetcher`.
3. Body (JSON): `{ "contactId": "{{contact.id}}" }`.
4. Map the returned `chart` into the agent's context/prompt variables.

### Live calls — Voice AI Custom Action
1. Add a **Custom Action** to the voice agent.
2. Same POST endpoint + `{ "contactId": "{{contact.id}}" }` body.
3. Feed the `chart` response into the call context.

Both channels hit the **same** endpoint.

---

## Backfill / ingestion

`scripts/backfill-conversations.js` pulls GHL conversation history (all channels)
into `CONVERSATION_MESSAGES`. Idempotent (dedupes on `message_id`). Email bodies
are resolved via `GET /conversations/messages/email/{emailMessageId}` when the
list `body` is a storage URL. Re-run to pick up net-new messages.

---

## Deploy prerequisites

- Vercel `AIRTABLE_API_KEY` must be the **valid** PAT (set with `printf`, not `echo`).
- `GHL_PRIVATE_API_KEY`, `GHL_API_BASE`, `GHL_LOCATION_ID` for the behavioral read.
- Full-findings persistence (`latest_optimization_findings_full`) requires the new
  Airtable fields + the CRS-sync writeback — review before enabling in prod.
