# UnderwriteIQ Lite - API Backend

Credit report analyzer backend for FundHub. Parses credit reports, determines funding eligibility, generates dispute letters, and syncs with GoHighLevel CRM.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT FLOW                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   [User Upload]                                                              │
│        │                                                                     │
│        ▼                                                                     │
│   ┌─────────────────┐                                                        │
│   │  FundHub Website │  (fundhub-website-GHL repo)                          │
│   │  credit-analyzer │                                                       │
│   └────────┬────────┘                                                        │
│            │ POST /api/lite/switchboard                                      │
│            │ (PDF + name + email + phone)                                    │
│            ▼                                                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                           VERCEL BACKEND                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                        SWITCHBOARD                                   │   │
│   │                    (api/lite/switchboard.js)                         │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│            │                                                                 │
│            ▼                                                                 │
│   ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐       │
│   │  Stage 1        │     │  Stage 2        │     │  Stage 3        │       │
│   │  Pre-Validate   │────▶│  GPT-4.1 Parse  │────▶│  Bureau Merge   │       │
│   │  (size, type,   │     │  (Vision API)   │     │  (dedupe check) │       │
│   │   duplicates)   │     │                 │     │                 │       │
│   └─────────────────┘     └─────────────────┘     └─────────────────┘       │
│                                                          │                   │
│                                                          ▼                   │
│   ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐       │
│   │  Stage 3b       │     │  Stage 4        │     │  Stage 5        │       │
│   │  Identity Gate  │────▶│  Underwrite     │────▶│  Suggestions    │       │
│   │  (name match,   │     │  (score, util,  │     │  (optimization  │       │
│   │   30-day check) │     │   fundable?)    │     │   cards)        │       │
│   └─────────────────┘     └─────────────────┘     └─────────────────┘       │
│                                                          │                   │
│                                                          ▼                   │
│                                              ┌───────────┴───────────┐       │
│                                              │                       │       │
│                                        ┌─────┴─────┐           ┌─────┴─────┐ │
│                                        │ FUNDABLE  │           │  REPAIR   │ │
│                                        │ Score≥700 │           │ Otherwise │ │
│                                        │ Util≤30%  │           │           │ │
│                                        │ Neg=0     │           │           │ │
│                                        └─────┬─────┘           └─────┬─────┘ │
│                                              │                       │       │
│                                              ▼                       ▼       │
│                                        ┌───────────┐           ┌───────────┐ │
│                                        │ 6 Letters │           │12 Letters │ │
│                                        │ 3 inquiry │           │ 9 dispute │ │
│                                        │ 3 personal│           │ 3 personal│ │
│                                        └─────┬─────┘           └─────┬─────┘ │
│                                              │                       │       │
│                                              └───────────┬───────────┘       │
│                                                          │                   │
│                                                          ▼                   │
│                                              ┌─────────────────────┐         │
│                                              │   Vercel Blob       │         │
│                                              │   (PDF Storage)     │         │
│                                              │   72hr expiry URLs  │         │
│                                              └──────────┬──────────┘         │
│                                                         │                    │
└─────────────────────────────────────────────────────────┼────────────────────┘
                                                          │
                                                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           GOHIGHLEVEL (GHL)                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                     Inbound Webhook                                  │   │
│   │          (underwriteiq_analyzer_complete)                            │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│            │                                                                 │
│            ▼                                                                 │
│   ┌─────────────────┐                                                        │
│   │ Contact Upsert  │  (Create or update by email/phone)                    │
│   └────────┬────────┘                                                        │
│            │                                                                 │
│            ▼                                                                 │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                     Custom Fields Mapped                             │   │
│   ├─────────────────────────────────────────────────────────────────────┤   │
│   │  analyzer_path          = "repair" | "funding"                       │   │
│   │  analyzer_status        = "complete"                                 │   │
│   │  letters_ready          = "true"                                     │   │
│   │  credit_score           = 580                                        │   │
│   │  credit_suggestions     = "Remove negatives..."                      │   │
│   │                                                                      │   │
│   │  REPAIR LETTERS:                                                     │   │
│   │  repair_letter_round_1_ex/eq/tu                                      │   │
│   │  repair_letter_round_2_ex/eq/tu                                      │   │
│   │  repair_letter_round_3_ex/eq/tu                                      │   │
│   │  repair_letter_personal_info_ex/eq/tu                                │   │
│   │                                                                      │   │
│   │  FUNDING LETTERS:                                                    │   │
│   │  funding_letter_inquiry_ex/eq/tu                                     │   │
│   │  funding_letter_personal_info_ex/eq/tu                               │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│            │                                                                 │
│            ▼                                                                 │
│   ┌─────────────────┐     ┌─────────────────┐                               │
│   │ Repair Workflow │ OR  │Funding Workflow │                               │
│   │ (email + tags)  │     │ (email + tags)  │                               │
│   └─────────────────┘     └─────────────────┘                               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Component      | Technology                     |
| -------------- | ------------------------------ |
| Backend        | Node.js 22 + Vercel Serverless |
| AI Parsing     | OpenAI GPT-4.1 Vision          |
| PDF Generation | pdf-lib                        |
| PDF Storage    | Vercel Blob (72hr URLs)        |
| CRM            | GoHighLevel (GHL)              |
| Cache/Dedupe   | Upstash Redis                  |
| Rate Limiting  | Upstash Ratelimit              |

---

## API Endpoints

| Endpoint                      | Description                              |
| ----------------------------- | ---------------------------------------- |
| `POST /api/lite/switchboard`  | Main analyzer - upload PDFs, get results |
| `POST /api/lite/parse-report` | Parse single PDF (internal)              |
| `GET /api/lite/health`        | Health check                             |

---

## Validation Rules

| Rule             | Stage      | Error Message                      |
| ---------------- | ---------- | ---------------------------------- |
| Max 3 files      | Pre-parse  | "Upload up to 3 PDFs only"         |
| PDF format       | Pre-parse  | "Only PDF credit reports accepted" |
| Min 40KB         | Pre-parse  | "PDF too small to be complete"     |
| Duplicate file   | Pre-parse  | "Duplicate file detected"          |
| Duplicate bureau | Post-parse | "Duplicate Experian detected"      |
| Name mismatch    | Post-parse | "Name does not match report"       |
| Report >30 days  | Post-parse | "Report is X days old"             |

---

## Fundable vs Repair Logic

```
IF score >= 700 AND utilization <= 30% AND negatives = 0:
    → FUNDABLE PATH (6 letters)
ELSE:
    → REPAIR PATH (12 letters)
```

---

## Letter Generation

### Repair Path (12 letters)

- 9 dispute letters (3 rounds × 3 bureaus)
- 3 personal info letters (1 per bureau)

### Fundable Path (6 letters)

- 3 inquiry removal letters (1 per bureau)
- 3 personal info letters (1 per bureau)

---

## Environment Variables

```bash
# OpenAI
UNDERWRITE_IQ_VISION_KEY=sk-...

# Vercel Blob
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...

# GoHighLevel
GHL_API_BASE=https://services.leadconnectorhq.com
GHL_PRIVATE_API_KEY=pit-...
GHL_LOCATION_ID=...

# Upstash Redis (dedupe/rate limit)
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...

# Redirects
REDIRECT_URL_FUNDABLE=https://fundhub.ai/funding-approved
REDIRECT_URL_NOT_FUNDABLE=https://fundhub.ai/fix-my-credit
```

---

## Project Structure

```
underwrite-iq-lite/
├── api/lite/
│   ├── switchboard.js        # Main orchestrator
│   ├── parse-report.js       # GPT-4.1 Vision parser
│   ├── validate-reports.js   # Pre-parse validation
│   ├── validate-identity.js  # Name match + 30-day check
│   ├── underwriter.js        # Fundable/repair logic
│   ├── letter-generator.js   # PDF letter creation
│   ├── letter-delivery.js    # Letter orchestration
│   ├── storage.js            # Vercel Blob uploads
│   ├── ghl-contact-service.js # GHL API integration
│   ├── suggestions.js        # Optimization suggestions
│   ├── dedupe-store.js       # Redis cache
│   ├── rate-limiter.js       # Rate limiting
│   ├── ai-gatekeeper.js      # Pre-parse AI check
│   └── __tests__/            # 354 tests
├── package.json
└── vercel.json
```

---

## Development

```bash
# Install
npm install

# Run locally
npm run dev

# Run tests
npm test

# Lint
npm run lint
```

---

## Deployment

- **Staging:** Push to `staging` branch → auto-deploys to `underwrite-iq-lite-staging.vercel.app`
- **Production:** Merge to `main` → auto-deploys to `underwrite-iq-lite.vercel.app`

---

## GHL Webhook Payload

```json
{
  "first_name": "John",
  "last_name": "Doe",
  "email": "john@example.com",
  "phone": "5551234567",
  "business_name": "Acme LLC",
  "business_age_months": 24,

  "analyzer_path": "repair",
  "analyzer_status": "complete",
  "letters_ready": "true",

  "credit_score": 580,
  "credit_utilization": 45,
  "negative_accounts": 3,
  "credit_suggestions": "Remove collections...",

  "repair_letter_round_1_ex": "https://...",
  "repair_letter_round_1_eq": "https://...",
  "repair_letter_round_1_tu": "https://...",
  "repair_letter_personal_info_ex": "https://...",
  ...
}
```

---

## Testing

```bash
# Run all tests
npm test

# Run specific test file
npm test -- api/lite/__tests__/validate-identity.test.js
```

Current: **354 tests passing**
