# UnderwriteIQ Lite — API Backend

Credit report analyzer backend for FundHub. Parses credit reports, determines funding eligibility, generates dispute letters and summary documents, and syncs with GoHighLevel CRM.

**Current version:** v2  
**Tests:** 864 pass, 3 skip  
**Deployed to:** `underwrite-iq-lite.vercel.app`

---

## How It Works (Simple Overview)

Two separate pipelines feed the same underwriting engine:

**Pipeline A — PDF Upload (public-facing)**

```
User uploads PDF → AI parses → Identity gate → Underwrite → Letters → GHL sync
```

**Pipeline B — CRS Soft-Pull (internal / Airtable-triggered)**

```
Airtable trigger → Pull Stitch Credit bureaus → 12-module CRS engine → Claude doc gen → Airtable + GHL sync
```

Both pipelines converge on the same 6-tier outcome ladder and letter generation logic.

---

## 6-Tier Outcome Ladder

The CRS engine routes every applicant to one of six tiers using a waterfall decision (most restrictive first):

| Tier | When | What Happens |
|------|------|--------------|
| `FRAUD_HOLD` | Identity gate failed, OFAC match, or high fraud score | No documents. Internal review required. |
| `MANUAL_REVIEW` | No median score, low bureau confidence, or identity soft-fail | No documents. Operator reviews manually. |
| `REPAIR_ONLY` | Active negatives present AND all bureaus are dirty | Repair path only — 3 rounds of dispute letters. |
| `FUNDING_PLUS_REPAIR` | Active negatives present BUT at least one bureau is clean | Fund on clean bureaus, repair dirty ones simultaneously. |
| `FULL_FUNDING` | All bureaus clean, utilization good/excellent, no thin file | Full funding path. All documents generated. |
| `PREMIUM_STACK` | Score >= 760, utilization <= 10%, revolving anchor >= $10K, 3+ revolving accounts | Same as FULL_FUNDING with premium lender tier unlocked. |

**Previous names (v1 → v2):**
- `REPAIR` → `REPAIR_ONLY`
- `CONDITIONAL_APPROVAL` → `FUNDING_PLUS_REPAIR`
- `FULL_STACK_APPROVAL` → `FULL_FUNDING`

---

## Pipeline A: PDF Upload

### Processing Flow

```
1.  Pre-Validation (validate-reports.js)
    - File size/type (PDF only, 40KB min, 3 files max)
    - Duplicate detection by SHA-256
    - Reject tri-merge when multiple files uploaded

2.  Deduplication Check (dedupe-store.js)
    - Check Upstash Redis for 30-day cached results
    - Keys: user (email/phone hash), device (deviceId), ref (contactId)
    - Return cached redirect if found

3.  AI Gatekeeper (ai-gatekeeper.js)
    - gpt-4o-mini classifies PDF content
    - Rejects non-credit-report PDFs before expensive Vision call

4.  Credit Report Parsing (parse-report.js)
    - 3-tier strategy: text extract → Google OCR → GPT-4.1 Vision
    - Handles single-bureau, tri-merge, and AnnualCreditReport.com formats
    - Returns strict JSON: bureaus.{experian,equifax,transunion}

5.  Bureau Merge (credit-ingestion.js)
    - Dedupe bureaus by name (one per bureau allowed)
    - Keep newer reports by reportDate

6.  Identity Validation (validate-identity.js)
    - Fuzzy name match against report name (90% threshold)
    - Reject reports older than 30 days

7.  Underwriting (underwriter.js)
    - Score normalization across bureaus
    - Fundable: zero negatives AND utilization <= 30%
    - Produces path assignment: "funding" or "repair"

8.  Suggestions (suggestions.js)
    - Optimization cards based on underwriting results

9.  Letter Generation (letter-generator.js + letter-delivery.js)
    - Repair path:  12 letters (9 dispute rounds + 3 personal info)
    - Funding path:  6 letters (3 inquiry removal + 3 personal info)
    - Upload to Vercel Blob (72hr expiry URLs)

10. GHL Sync (ghl-contact-service.js)
    - Create/update contact by email/phone
    - Map custom fields (analyzer_path, credit_score, letter URLs)
    - Trigger repair or funding workflow

11. Cache Results (dedupe-store.js)
    - Store redirect payload in Redis (30-day TTL)
```

### PDF Processing — 3-Tier Strategy

| Step | Method | When Used | Time | Cost |
|------|--------|-----------|------|------|
| 1 | `pdf-parse` text extraction | Always (first attempt) | ~50ms | $0 |
| 2 | Google Cloud Vision OCR | Text layer empty or < 1000 chars | 10-20s | ~$0.003-0.005 |
| 3 | GPT-4.1 Vision | OCR unavailable or fails | 30-60s | ~$0.02-0.05 |

Most digitally-generated credit reports (TransUnion, IdentityIQ, SmartCredit) are handled entirely by the text path — no AI image call needed.

### Fundable vs Repair Logic (PDF pipeline)

The PDF pipeline uses a simpler binary check than the CRS engine:

```
IF negatives = 0 AND utilization <= 30%:
    FUNDING PATH  — 6 letters (3 inquiry removal + 3 personal info)
ELSE:
    REPAIR PATH   — 12 letters (9 dispute rounds + 3 personal info)
```

### 30-Day Deduplication

| Key Type | Format | Purpose |
|----------|--------|---------|
| User | `uwiq:u:<sha256(email|phone)>` | Prevent same person resubmitting |
| Device | `uwiq:d:<deviceId>` | Browser localStorage cross-session |
| Ref | `uwiq:r:<contactId>` | Cross-device attribution via GHL contact |

On a cache hit the system returns the stored redirect immediately — no reprocessing.

---

## Pipeline B: CRS Soft-Pull Engine

### Entry Points

```
POST /api/lite/crs-analyze          — accepts raw Stitch Credit responses
POST /api/lite/crs-pull-and-analyze — accepts applicant identity, pulls bureaus, runs engine
POST /api/lite/trigger-crs-pull     — Airtable BRIDGE automation trigger
```

### 12-Module Engine (`api/lite/crs/`)

| # | Module | Role |
|---|--------|------|
| 1 | `normalize-soft-pull.js` | Ingest and normalize raw Stitch Credit CRS data |
| 2 | `derive-consumer-signals.js` | Score, utilization band, derogatory analysis, bureau cleanliness |
| 3 | `derive-business-signals.js` | Business credit signals from Experian commercial data |
| 4 | `identity-fraud-gate.js` | Name match, report freshness, fraud risk score |
| 5 | `route-outcome.js` | 6-tier outcome waterfall |
| 6 | `estimate-preapprovals.js` | Funding estimates (2 modifiers: utilization + thin file) |
| 7 | `optimization-findings.js` | 37 finding categories with exact account names and amounts |
| 8 | `build-suggestions.js` | 4-tier suggestion layers with AI-generated text |
| 9 | `build-cards.js` | CRM tag array |
| 10 | `build-documents.js` | Letter and summary doc specs per outcome |
| 11 | `build-crm-payload.js` | GHL field mapping |
| 12 | `build-audit-trail.js` | Processing audit log |

**Supporting modules:**

| Module | Role |
|--------|------|
| `stitch-credit-client.js` | JWT auth, parallel bureau pulls |
| `airtable-sync.js` | Bidirectional CRS ↔ FUNDHUB MATRIX sync |
| `engine.js` | Orchestrates all 12 modules |
| `generate-deliverables.js` | Claude API document generation orchestrator |
| `lender-matrix.js` | Rule-based lender matching (15 lenders) |
| `claude-client.js` | Claude API client with circuit breaker |
| `render-pdf.js` | PDF rendering for generated deliverables |
| `suggestion-text-generator.js` | GPT-4o-mini text for suggestion cards |

### Pre-Approval Estimator (Module 6)

**v2 — 2 modifiers only** (removed bureau confidence, inquiry pressure, AU dominance, business overlay):

```
personal_card_base  = revolving_anchor × 5.5  (floor: $5,000)
personal_loan_base  = installment_anchor × 3.0 (floor: $10,000)

modifier_product    = outcome_mod × utilization_mod × thin_file_mod

final_amount        = base × modifier_product
```

| Modifier | Values |
|----------|--------|
| Outcome | PREMIUM_STACK/FULL_FUNDING: 1.0, FUNDING_PLUS_REPAIR: 0.6, all others: 0 |
| Utilization | excellent: 1.0, good: 0.95, moderate: 0.8, high: 0.6, critical: 0.4 |
| Thin file | normal: 1.0, thin: 0.6 |

**Business credit** — any negative item OR any UCC filing = $0. No exceptions.

### Suggestion Engine v4 (Module 7-8)

- 37 finding categories covering: active negatives, utilization per account, thin file, AU impact, inquiry windows, business formation, and more
- One finding per account (no grouping)
- Names every creditor, gives exact dollar targets (utilization target always < 10%)
- AI text generation via GPT-4o-mini (5th-grade reading level)
- Findings include `projectedPreapproval` showing what the number would be after the fix

### Document Generation (Claude API)

`generate-deliverables.js` calls Claude (`claude-sonnet-4-6` by default) to produce:

**4 main documents (generated in parallel):**

| Document | Description |
|----------|-------------|
| `creditAnalysis` | Full credit profile analysis |
| `roadmap` | Step-by-step action roadmap |
| `fundingSnapshot` | Pre-approval summary with lender tier |
| `lenderMatchList` | Matched lenders with estimates and fit notes |

**Letters (generated sequentially to respect rate limits):**

| Letter | When Generated |
|--------|---------------|
| Dispute round 1, 2, 3 | Per dirty bureau — REPAIR_ONLY or FUNDING_PLUS_REPAIR |
| Personal info update | All outcomes, all bureaus |
| Inquiry removal | All outcomes, all bureaus |

The Claude client includes a circuit breaker: 3 consecutive failures open the circuit for 60 seconds. Document generation failures are soft — the pipeline continues and marks the failed doc as `null`.

### Lender Matching (15 lenders, rule-based)

No AI involved. Each lender has `minScore`, `minTIB`, optional `minRevenue`, and `requiresBiz` flags. Matching is pure boolean filtering.

Lenders include: Chase Ink Preferred, Amex Blue Business Plus, Capital One Spark Cash, OnDeck, Bluevine, Fundbox, Kabbage (Amex), SBA 7(a), Credibly, Chase Sapphire Preferred, Amex Gold, Lending Club, SoFi, Navy Federal, Marcus by Goldman Sachs.

---

## Event System

### Entry Point

```
POST /api/events
Authorization: Bearer <API_SECRET or EVENT_ROUTER_TOKEN>
```

### Event Envelope Shape

```json
{
  "event_name": "fundhub.analysis.completed",
  "event_version": 1,
  "event_id": "uuid-v4",
  "idempotency_key": "unique-key",
  "occurred_at": "2026-04-04T00:00:00Z",
  "source_system": "underwrite-iq",
  "correlation_id": "optional-trace-id",
  "contact": {
    "email": "client@example.com",
    "phone": "5551234567",
    "ghl_contact_id": "abc123",
    "airtable_client_record_id": "recXXX"
  },
  "adapter": {
    "entry_mode": "analyzer",
    "funnel_family": "credit_repair"
  },
  "payload": { }
}
```

### 8 Canonical Events

| Event Name | Trigger |
|-----------|---------|
| `fundhub.entry.captured` | New lead enters funnel (any source) |
| `fundhub.deposit.paid` | SLO deposit received |
| `fundhub.analysis.requested` | CRS pull triggered |
| `fundhub.analysis.completed` | CRS engine finishes |
| `fundhub.booking.lane.decided` | Outcome tier assigned, call lane routed |
| `fundhub.call.booked` | Booking confirmed |
| `fundhub.decision.recorded` | Underwriter decision saved |
| `fundhub.sale.closed` | Deal closed |

### 9 Handlers

`api/events/handlers/`: `entry-captured`, `deposit-paid`, `analysis-requested`, `analysis-completed`, `booking-lane-decided`, `call-booked`, `decision-recorded`, `sale-closed`, `client-upsert` (shared utility)

### Router Behavior

1. Validate envelope structure (6 required fields)
2. Normalize contact (email/phone)
3. Validate event-specific payload fields
4. Idempotency check via Upstash Redis (skip if already processed)
5. Log to Airtable `EVENT_LOG` (fire-and-forget)
6. Dispatch to handler
7. Mark processed in Redis

Redis down = warning logged, processing continues. Airtable log failure = silently ignored. Auth is skipped if neither `API_SECRET` nor `EVENT_ROUTER_TOKEN` is set (dev mode).

---

## Other Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/lite/switchboard` | POST | Main PDF analyzer — upload + results |
| `/api/lite/parse-report` | POST | Parse single PDF (internal use) |
| `/api/lite/upload-token` | GET | Get Vercel Blob upload token |
| `/api/lite/blob-upload` | POST | Client-side blob upload handler |
| `/api/lite/start-processing` | POST | Kick off async queue processing |
| `/api/lite/job-status` | GET | Poll job status |
| `/api/lite/process-worker` | POST | Worker — processes one queued job |
| `/api/lite/process-queue` | GET | Cron handler — drains queue (1-min schedule) |
| `/api/lite/crs-analyze` | POST | CRS engine — raw CRS data in |
| `/api/lite/crs-pull-and-analyze` | POST | CRS engine — pull bureaus + analyze |
| `/api/lite/trigger-crs-pull` | POST | Airtable BRIDGE trigger |
| `/api/lite/crs-sandbox-data` | GET | Return sandbox CRS fixture data |
| `/api/lite/airtable-reprocess` | POST | Re-run engine on existing Airtable record |
| `/api/lite/disputefox-relay` | POST | DisputeFox events → GHL (replaces 6 Zapier zaps) |
| `/api/lite/disputefox-intake` | POST | DisputeFox event router — writes df_* fields + pipeline stage |
| `/api/events` | POST | Modular event system entry point |

---

## API Validation Rules

| Rule | Stage | Error |
|------|-------|-------|
| Max 3 files | Pre-parse | `"Upload up to 3 PDFs only"` |
| PDF format | Pre-parse | `"Only PDF credit reports accepted"` |
| Min 40KB | Pre-parse | `"PDF too small to be complete"` |
| Duplicate file | Pre-parse | `"Duplicate file detected"` |
| Duplicate bureau | Post-parse | `"Duplicate Experian detected"` |
| Name mismatch | Post-parse | `"Name does not match report"` |
| Report > 30 days | Post-parse | `"Report is X days old"` |

---

## GHL Field Mapping

**Common Fields:**

| Field | Value |
|-------|-------|
| `analyzer_path` | `"repair"` or `"funding"` |
| `analyzer_status` | `"complete"` |
| `letters_ready` | `"true"` |
| `credit_score` | numeric |
| `credit_utilization` | numeric |
| `negative_accounts` | numeric |
| `credit_suggestions` | text |

**Repair Letters:**

```
repair_letter_url__round_1__ex / eq / tu
repair_letter_url__round_2__ex / eq / tu
repair_letter_url__round_3__ex / eq / tu
repair_letter_url__personal_info_dispute__ex / eq / tu
```

**Funding Letters:**

```
funding_letter_url__inquiry_cleanup__ex / eq / tu
funding_letter_url__personal_info_cleanup__ex / eq / tu
```

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Backend | Node.js 22 + Vercel Serverless |
| PDF Text Extraction | pdf-parse |
| OCR | Google Cloud Vision |
| AI Parsing (fallback) | GPT-4.1 Vision |
| Suggestion Text | GPT-4o-mini |
| Document Generation | Claude API (claude-sonnet-4-6) |
| PDF Generation | pdf-lib |
| PDF Storage | Vercel Blob (72hr URLs) |
| CRM | GoHighLevel |
| Soft-Pull Provider | Stitch Credit |
| OpsDB | Airtable (FUNDHUB MATRIX) |
| Cache / Dedupe / Idempotency | Upstash Redis |
| Rate Limiting | Upstash Ratelimit |
| Logging | pino |

---

## Environment Variables

### Required

```bash
# OpenAI (credit report parsing + suggestion text)
UNDERWRITE_IQ_VISION_KEY=sk-proj-...

# Vercel Blob (PDF storage, 72hr URLs)
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...

# GoHighLevel
GHL_PRIVATE_API_KEY=pit-...
GHL_API_BASE=https://services.leadconnectorhq.com
GHL_LOCATION_ID=your-location-id

# Upstash Redis (caching, deduplication, idempotency)
UPSTASH_REDIS_REST_URL=https://your-endpoint.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-token

# Redirect URLs
REDIRECT_URL_FUNDABLE=https://fundhub.ai/funding-approved-analyzer-462533
REDIRECT_URL_NOT_FUNDABLE=https://fundhub.ai/fix-my-credit-analyzer
REDIRECT_BASE_URL=https://fundhub.ai
```

### CRS Engine

```bash
# Stitch Credit (soft-pull bureau pulls)
STITCH_CREDIT_API_BASE=https://api-sandbox.stitchcredit.com
STITCH_CREDIT_USERNAME=your-admin-username
STITCH_CREDIT_PASSWORD=your-admin-password

# Airtable (FUNDHUB MATRIX sync)
AIRTABLE_API_KEY=your-pat
AIRTABLE_BASE_ID=your-base-id
AIRTABLE_TABLE_CLIENTS=Clients
AIRTABLE_TABLE_SNAPSHOTS=Credit Snapshots

# Claude API (document generation)
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-sonnet-4-6        # optional, default: claude-sonnet-4-6
CLAUDE_TIMEOUT=90000                  # optional, default: 90000ms
BOOKING_URL=https://fundhub.ai/book  # CTA link in generated docs
```

### Event System

```bash
# Auth — at least one required; both missing = auth skipped (dev mode)
API_SECRET=your-global-secret
EVENT_ROUTER_TOKEN=your-event-token

# Airtable EVENT_LOG table name (default: "Event Log")
AIRTABLE_TABLE_EVENT_LOG=Event Log
```

### Optional

```bash
# Parse Mode
PARSE_MODE=auto         # auto (text→OCR→Vision), vision, ocr
PARSE_MODEL=gpt-4.1     # gpt-4.1 or gpt-4o-mini

# Google Cloud Vision OCR (for scanned PDFs)
GOOGLE_PROJECT_ID=your-project-id
GOOGLE_CLIENT_EMAIL=your-service-account@project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

# Speed
SKIP_AI_GATEKEEPER=true  # skip gatekeeper check, saves ~3-5s

# Rate Limiting
RATE_LIMIT_ENABLED=true
RATE_LIMIT_MAX_REQUESTS=10
RATE_LIMIT_WINDOW=1 m

# Feature Flags
AFFILIATE_DASHBOARD_ENABLED=true
IDENTITY_VERIFICATION_ENABLED=true

# Logging
LOG_LEVEL=info  # trace, debug, info, warn, error, fatal

# Verification Services
CF_EMAIL_VALIDATION_TOKEN=...
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1...

# DisputeFox
DISPUTEFOX_RELAY_MODE=direct   # or "zapier"
DISPUTEFOX_INTAKE_SECRET=...
ZAPIER_WEBHOOK_URL=...         # only needed when RELAY_MODE=zapier
```

---

## File Structure

```
underwrite-iq-lite/
├── api/
│   ├── events/
│   │   ├── index.js                    # POST /api/events entry point
│   │   ├── router.js                   # Envelope validation + dispatch
│   │   ├── handlers/
│   │   │   ├── entry-captured.js
│   │   │   ├── deposit-paid.js
│   │   │   ├── analysis-requested.js
│   │   │   ├── analysis-completed.js
│   │   │   ├── booking-lane-decided.js
│   │   │   ├── call-booked.js
│   │   │   ├── decision-recorded.js
│   │   │   ├── sale-closed.js
│   │   │   └── client-upsert.js        # Shared contact upsert utility
│   │   └── utils/
│   │       ├── idempotency.js          # Redis idempotency store
│   │       └── normalize.js            # Contact normalization + payload validation
│   └── lite/
│       ├── switchboard.js              # PDF pipeline orchestrator
│       ├── parse-report.js             # 3-tier AI parser
│       ├── pdf-text-extractor.js       # Text + OCR extraction
│       ├── ai-gatekeeper.js            # gpt-4o-mini PDF classifier
│       ├── credit-ingestion.js         # Tri-merge detector + bureau merge
│       ├── validate-reports.js         # Pre-parse file validation
│       ├── validate-identity.js        # Name match + 30-day recency
│       ├── underwriter.js              # Fundable/repair binary logic
│       ├── letter-generator.js         # pdf-lib letter creation
│       ├── letter-delivery.js          # Letter orchestration
│       ├── suggestions.js              # Suggestion cards (PDF pipeline)
│       ├── ghl-contact-service.js      # GHL API integration
│       ├── ghl-webhook.js              # Inbound GHL webhook handler
│       ├── dedupe-store.js             # Redis 30-day cache
│       ├── rate-limiter.js             # Upstash Ratelimit
│       ├── input-sanitizer.js          # XSS/injection protection
│       ├── crs-analyze.js              # CRS analyze endpoint
│       ├── crs-pull-and-analyze.js     # CRS pull + analyze endpoint
│       ├── trigger-crs-pull.js         # Airtable BRIDGE trigger
│       ├── airtable-reprocess.js       # Re-run CRS on existing record
│       ├── disputefox-relay.js         # DisputeFox → GHL relay
│       ├── disputefox-intake.js        # DisputeFox event router
│       ├── process-queue.js            # Cron queue drain (1-min)
│       ├── process-worker.js           # Async job worker
│       ├── job-store.js                # Job status Redis store
│       ├── storage.js                  # Vercel Blob helpers
│       ├── logger.js                   # pino-based logger
│       ├── crs/
│       │   ├── engine.js               # 12-module CRS orchestrator
│       │   ├── normalize-soft-pull.js  # Stage 1
│       │   ├── derive-consumer-signals.js # Stage 2
│       │   ├── derive-business-signals.js # Stage 3
│       │   ├── identity-fraud-gate.js  # Stage 4
│       │   ├── route-outcome.js        # Stage 5 — 6-tier ladder
│       │   ├── estimate-preapprovals.js # Stage 6
│       │   ├── optimization-findings.js # Stage 7 — 37 finding types
│       │   ├── build-suggestions.js    # Stage 8
│       │   ├── build-cards.js          # Stage 9
│       │   ├── build-documents.js      # Stage 10
│       │   ├── build-crm-payload.js    # Stage 11
│       │   ├── build-audit-trail.js    # Stage 12
│       │   ├── generate-deliverables.js # Claude API orchestrator
│       │   ├── lender-matrix.js        # 15-lender rule-based matcher
│       │   ├── claude-client.js        # Claude API client + circuit breaker
│       │   ├── suggestion-text-generator.js # GPT-4o-mini text gen
│       │   ├── doc-prompts.js          # Claude system prompts
│       │   ├── render-pdf.js           # PDF renderer for generated docs
│       │   ├── stitch-credit-client.js # Stitch Credit API client
│       │   ├── airtable-sync.js        # Airtable FUNDHUB MATRIX sync
│       │   └── summary-doc-generator.js # pdf-lib summary PDFs
│       └── __tests__/                  # 864 tests (40 test files)
├── public/
│   ├── prod-upload.html               # Single-file parser UI
│   └── tester.html                    # Switchboard test UI
├── package.json
├── vercel.json                        # Routes + 1-minute cron
└── .env.example
```

---

## Development

```bash
# Install
npm install

# Local dev server
npm run dev          # Vercel dev (localhost:3000)
npm run dev:test     # Test server (test-server.js)

# Lint & format
npm run lint
npm run lint:fix
npm run format
npm run format:check
```

### Deployment

- **Staging:** Push to `staging` branch → auto-deploys to `underwrite-iq-lite-staging.vercel.app`
- **Production:** Merge to `main` → auto-deploys to `underwrite-iq-lite.vercel.app`

---

## Testing

864 pass, 3 skip (40 test files).

```bash
# All tests
npm test

# Single file
npm test -- api/lite/__tests__/validate-identity.test.js

# With test server (E2E)
# Terminal 1:
npm run dev:test
# Terminal 2:
PARSE_ENDPOINT=http://localhost:3000/api/lite/parse-report \
  TEST_SERVER_URL=http://localhost:3000 \
  node --test api/lite/__tests__/switchboard.e2e.test.js

# Coverage
npm run test:coverage
npm run coverage
npm run coverage:check
```

### Test File Coverage

```
api/lite/__tests__/
├── switchboard.e2e.test.js
├── validate-identity.test.js
├── underwriter.test.js
├── letter-generator.test.js
├── letter-delivery.test.js
├── ghl-contact-service.test.js
├── dedupe-store.test.js
├── credit-ingestion.test.js
├── crs-engine.test.js
├── crs-analyze.test.js
├── crs-pull-and-analyze.test.js
├── normalize-soft-pull.test.js
├── derive-consumer-signals.test.js
├── derive-business-signals.test.js
├── identity-fraud-gate.test.js
├── route-outcome.test.js
├── estimate-preapprovals.test.js
├── optimization-findings.test.js
├── build-suggestions.test.js
├── summary-doc-generator.test.js
├── stitch-credit-client.test.js
├── airtable-sync.test.js
└── ... (40 files total)
```

---

## Error Handling Conventions

**All modules return a consistent shape:**

```javascript
// Error
{ ok: false, error: "ERROR_CODE", message: "User-friendly message", details: {} }

// Success
{ ok: true, data: { /* payload */ } }
```

**Logging** (pino-based via `logger.js`):

```javascript
const { logInfo, logWarn, logError } = require("./logger");
logInfo("Processing started", { userId: "123" });
logWarn("Rate limit approaching", { ip });
logError("Parse failed", { error: err.message });
```

---

## Security

| Concern | Mitigation |
|---------|-----------|
| XSS / injection | All user inputs pass through `input-sanitizer.js` |
| Rate abuse | Upstash Ratelimit (configurable, default 10 req/min) |
| PII in cache | Email/phone hashed SHA-256 before Redis storage |
| File abuse | Size, type, and content validated before any AI call |
| Non-credit PDFs | gpt-4o-mini gatekeeper rejects before Vision call |
| Temp files | Cleaned from `/tmp` after every request |
| Event auth | Bearer token required (API_SECRET or EVENT_ROUTER_TOKEN) |
| Claude failure | Circuit breaker opens after 3 consecutive failures |

---

## Troubleshooting

**Tests failing:**

```bash
cat .env.example
NODE_ENV=test node --test --test-reporter=spec api/lite/__tests__/*.test.js
lsof -i :3000
```

**Rate limit issues:**

```bash
curl "https://your-endpoint.upstash.io/get/test" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"
export RATE_LIMIT_ENABLED=false
```

**Parse errors:**

```bash
curl https://api.openai.com/v1/models \
  -H "Authorization: Bearer $UNDERWRITE_IQ_VISION_KEY"
export PARSE_MODEL=gpt-4o-mini
export SKIP_AI_GATEKEEPER=true
```

**GHL sync failures:**

```bash
curl "https://services.leadconnectorhq.com/contacts/" \
  -H "Authorization: Bearer $GHL_PRIVATE_API_KEY" \
  -H "Version: 2021-07-28"
echo $GHL_LOCATION_ID
```

**Claude document generation failures:**

Document generation is soft-fail by default — check Vercel logs for `generate-deliverables` errors. Circuit breaker resets after 60 seconds. If the circuit is open, all 4 main docs will be `null` but the pipeline continues.

---

## Known Gotchas

1. **Tri-merge + multi-file**: If multiple PDFs uploaded and one is tri-merge, pre-validation rejects the whole request.
2. **Bureau name normalization**: Case-insensitive (`"experian"` = `"Experian"` = `"EXPERIAN"`).
3. **Report date parsing**: Supports ISO, MM/DD/YYYY, and other common formats.
4. **Redis unavailable**: System continues without caching — logs warning, does not block.
5. **GHL API errors**: Soft failures — logged but do not block the pipeline. User still gets redirect.
6. **`forceReprocess` flag**: Defaults to `true` in the PDF pipeline (bypasses dedup). Set to `false` to use cache.
7. **Business cap**: Any negative item or UCC filing in business signals = $0 business pre-approval, hard.
8. **FUNDING_PLUS_REPAIR default**: Applicants who have no active negatives but don't meet full funding criteria default to `FUNDING_PLUS_REPAIR` (medium confidence).
9. **Event auth bypass**: If neither `API_SECRET` nor `EVENT_ROUTER_TOKEN` is set, the event router logs a warning and accepts all requests — intended for local dev only.
