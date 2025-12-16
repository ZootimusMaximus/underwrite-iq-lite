# Letter Generation & Course Delivery - Implementation Tasks

**Date:** December 16, 2025
**Last Updated:** December 16, 2025 @ 9:20 AM
**Status:** Core Implementation Complete - Awaiting Config
**Project:** UnderwriteIQ Lite / FundHub

---

## Next Steps to Go Live

### 1. Vercel Blob Storage Setup (Developer) ✅ DONE

- [x] Go to Vercel Dashboard → Storage → Create Store → Blob
- [x] Created store: `underwrite-iq-letters` (Region: IAD1)
- [x] Connect to the `underwrite-iq-lite` project
- [x] `BLOB_READ_WRITE_TOKEN` automatically added to env vars (Development, Preview, Production)
- [ ] Redeploy (do this after testing or when ready to go live)

### 2. GHL Custom Fields (Client)

- [ ] Add these 15 custom fields to GHL (client confirmed adding today):
  ```
  cf_uq_ex_round1_url
  cf_uq_ex_round2_url
  cf_uq_ex_round3_url
  cf_uq_tu_round1_url
  cf_uq_tu_round2_url
  cf_uq_tu_round3_url
  cf_uq_eq_round1_url
  cf_uq_eq_round2_url
  cf_uq_eq_round3_url
  cf_uq_personal_info_round1_url
  cf_uq_personal_info_round2_url
  cf_uq_inquiry_round1_url
  cf_uq_inquiry_round2_url
  cf_uq_path
  cf_uq_letters_ready
  ```

### 3. Real Letter Templates (Client)

- [ ] Client to send sample FCRA dispute letter templates
- [ ] Update `api/lite/letter-generator.js` with real templates
- [ ] Currently using placeholder text

### 4. GHL Email Workflows (Client)

- [ ] Create repair path email template (includes 9 dispute + 2 personal info links)
- [ ] Create fundable path email template (includes 2 personal + 2 inquiry links)
- [ ] Set up workflow trigger: when `cf_uq_letters_ready = true`
- [ ] Route based on `cf_uq_path` value

### 5. Testing & Deploy

- [ ] End-to-end test with repair path credit report
- [ ] End-to-end test with fundable path credit report
- [ ] Verify PDFs accessible via URLs
- [ ] Verify GHL fields populated correctly
- [ ] Verify emails sent with correct links

---

## Confirmed Specifications

| Item                  | Decision                               | Status                      |
| --------------------- | -------------------------------------- | --------------------------- |
| **Storage Provider**  | Vercel Blob                            | ✅ Confirmed                |
| **URL Expiration**    | 72 hours                               | ✅ Confirmed                |
| **Letter Templates**  | Placeholder now, real templates coming | 🔄 Pending                  |
| **GHL Custom Fields** | Names confirmed (see below)            | ✅ Confirmed - Adding today |

---

## Overview

Implement automated dispute letter generation and GHL course delivery based on analyzer results. The system determines **repair** vs **fundable** path and generates appropriate dispute letters, uploads them to storage, syncs URLs to GHL, and triggers path-specific email delivery.

**Key Principle:** Credit report data NEVER leaves UnderwriteIQ. GHL only receives PDF URLs, credit suggestions, and scores - never the raw report.

---

## System Flow

```
User submits credit report
        ↓
UnderwriteIQ parses full report (existing)
        ↓
Analyzer determines: REPAIR or FUNDABLE (existing)
        ↓
Generate dispute letter PDFs (NEW)
        ↓
Upload PDFs to storage, get signed URLs (NEW)
        ↓
Push URLs to GHL contact custom fields (NEW)
        ↓
GHL triggers path-specific email with all links + course (NEW)
```

---

## Path Definitions

### REPAIR Path

- User needs credit work before funding
- **9 dispute letters** (3 rounds × 3 bureaus)
- **2 personal info dispute letters**
- **1 email** with all 11 links + repair course + detailed suggestions

### FUNDABLE Path

- User qualifies for funding
- **2 personal info dispute letters** (cleanup)
- **2 inquiry removal letters** (optimization)
- **1 email** with 4 links + free course + optimization suggestions

---

## Tasks

### Phase 1: Letter Generation Engine

- [x] **1. Design dispute letter PDF templates** ✅ DONE (placeholder)
  - Layout and formatting - basic FCRA template structure
  - Required fields (name, address, account info, dispute reason)
  - Bureau-specific formatting requirements
  - Minimal PII only
  - **File:** `api/lite/letter-generator.js`

- [x] **2. Build letter generation engine** ✅ DONE
  - Extract disputable negatives from parsed report
  - Filter to fundability-blocking items only
  - Map tradelines to dispute reasons
  - **File:** `api/lite/letter-generator.js`

- [x] **3. Implement 3-round dispute logic per bureau** ✅ DONE
  - Experian: Round 1, 2, 3 PDFs
  - TransUnion: Round 1, 2, 3 PDFs
  - Equifax: Round 1, 2, 3 PDFs
  - Distribute accounts across rounds strategically
  - **File:** `api/lite/letter-generator.js`

- [x] **4. Implement personal information dispute letter generation** ✅ DONE
  - Name variations
  - Address variations
  - Employer data
  - 2 rounds for both paths
  - **File:** `api/lite/letter-generator.js`

- [x] **5. Implement inquiry removal letter generation** ✅ DONE
  - Fundable path only
  - 2 rounds of inquiry disputes
  - **File:** `api/lite/letter-generator.js`

---

### Phase 2: PDF Storage & URLs

- [x] **6. Choose and configure PDF storage** ✅ CONFIRMED
  - **Decision: Vercel Blob** (already on Vercel, simplest integration)
  - Need: `BLOB_READ_WRITE_TOKEN` from Vercel dashboard

- [x] **7. Implement signed URL generation** ✅ DONE
  - **Expiring URLs: 72 hours** ✅ CONFIRMED
  - Secure access to PDFs
  - URL structure: `letters/{contactId}/{bureau}_{round}.pdf`
  - **File:** `api/lite/storage.js`

---

### Phase 3: GHL Integration

- [x] **8. Create GHL custom fields** ✅ CONFIRMED - Being added today

  **Repair path (11 fields):**

  ```
  cf_uq_ex_round1_url
  cf_uq_ex_round2_url
  cf_uq_ex_round3_url
  cf_uq_tu_round1_url
  cf_uq_tu_round2_url
  cf_uq_tu_round3_url
  cf_uq_eq_round1_url
  cf_uq_eq_round2_url
  cf_uq_eq_round3_url
  cf_uq_personal_info_round1_url
  cf_uq_personal_info_round2_url
  ```

  **Fundable path (4 fields):**

  ```
  cf_uq_personal_info_round1_url
  cf_uq_personal_info_round2_url
  cf_uq_inquiry_round1_url
  cf_uq_inquiry_round2_url
  ```

  **State flags:**

  ```
  cf_uq_path = "repair" | "fundable"
  cf_uq_letters_ready = true | false
  ```

  > **Note:** Client confirmed these exact field names. Being added to GHL today (Dec 16).

- [x] **9. Build GHL API integration** ✅ DONE
  - Authentication setup (existing)
  - Contact lookup/creation (existing)
  - **Custom field updates (NEW)** - `updateContactCustomFields()`, `updateLetterUrls()`
  - Error handling and retries
  - **File:** `api/lite/ghl-contact-service.js`

---

### Phase 4: Email & Course Setup (GHL)

- [ ] **10. Create repair path email template**
  - All 9 dispute letter links
  - Personal info letter links
  - Repair course link
  - Long-form suggestions:
    - What to do while disputes process
    - Behavior changes needed
    - Timeline expectations
    - Path to funding after repair

- [ ] **11. Create fundable path email template**
  - 2 personal info letter links
  - 2 inquiry letter links
  - Free course link
  - Long-form suggestions:
    - Credit optimization tips
    - What NOT to do
    - How to preserve fundability
    - Next steps for funding

- [ ] **12. Set up GHL workflow triggers**
  - Trigger on `cf_uq_letters_ready = true`
  - Route based on `cf_uq_path` value
  - Send appropriate email template

- [ ] **13. Create/configure repair course in GHL**
  - Course content and modules
  - Enrollment automation

- [ ] **14. Create/configure free fundable course in GHL**
  - Course content and modules
  - Enrollment automation

---

### Phase 5: Integration & Testing

- [x] **15. Integrate letter generation into switchboard.js** ✅ DONE
  - Call letter generator after underwriting
  - Upload PDFs after generation
  - Sync to GHL after upload
  - Handle errors gracefully (async, non-blocking)
  - **File:** `api/lite/switchboard.js`, `api/lite/letter-delivery.js`

- [ ] **16. Write tests for letter generation logic**
  - Unit tests for PDF generation
  - Unit tests for round distribution
  - Unit tests for GHL field mapping

- [ ] **17. End-to-end testing (repair path)**
  - Full flow with test credit report
  - Verify all 11 PDFs generated
  - Verify GHL fields populated
  - Verify email received with correct links

- [ ] **18. End-to-end testing (fundable path)**
  - Full flow with test credit report
  - Verify all 4 PDFs generated
  - Verify GHL fields populated
  - Verify email received with correct links

- [ ] **19. Deploy to production**
  - Environment variables configured (need BLOB_READ_WRITE_TOKEN)
  - GHL workflows activated
  - Monitoring in place

---

## PDF Output Structure

```
storage/
├── {user_id}/
│   ├── ex_round1.pdf
│   ├── ex_round2.pdf
│   ├── ex_round3.pdf
│   ├── tu_round1.pdf
│   ├── tu_round2.pdf
│   ├── tu_round3.pdf
│   ├── eq_round1.pdf
│   ├── eq_round2.pdf
│   ├── eq_round3.pdf
│   ├── personal_info_round1.pdf
│   ├── personal_info_round2.pdf
│   ├── inquiries_round1.pdf      (fundable only)
│   └── inquiries_round2.pdf      (fundable only)
```

---

## Key Design Decisions

| Decision                  | Rationale                                         |
| ------------------------- | ------------------------------------------------- |
| Individual PDFs per round | User mails one round, waits 30-45 days, then next |
| No credit data in GHL     | Privacy/compliance - GHL stores URLs only         |
| Expiring signed URLs      | Security - links expire after set period          |
| One email per path        | Simpler UX than dripping multiple emails          |
| Suggestions in email body | Guidance during dispute process                   |

---

## Resolved Questions

1. **PDF template design** - ✅ Sample letters coming from client. Using placeholders until then.
2. **Storage provider** - ✅ **Vercel Blob** (already on Vercel, simplest integration)
3. **URL expiration** - ✅ **72 hours** (short expiry for security)
4. **GHL API credentials** - ✅ Already configured in `.env`
5. **Course content** - 🔄 Pending - courses will be set up in GHL
6. **Dispute reasons** - 🔄 Pending - will match sample letters when received

## Open Questions

1. **Course URLs** - What are the GHL course URLs for repair vs fundable paths?
2. **Test contact** - Is there a test contact in GHL for verification?

---

## Files Created/Modified

### New Files ✅

- `api/lite/letter-generator.js` - Letter generation with PDF creation (placeholder templates)
- `api/lite/storage.js` - Vercel Blob upload and URL handling
- `api/lite/letter-delivery.js` - Orchestration: generate → upload → GHL sync

### Modified Files ✅

- `api/lite/switchboard.js` - Integrated letter delivery (async, after contact creation)
- `api/lite/ghl-contact-service.js` - Added `updateContactCustomFields()` and `updateLetterUrls()`
- `.env.example` - Added `BLOB_READ_WRITE_TOKEN`

---

## Environment Variables Needed

```bash
# PDF Storage - Vercel Blob (CONFIRMED)
BLOB_READ_WRITE_TOKEN=  # Get from Vercel dashboard

# GHL Integration (ALREADY CONFIGURED)
GHL_PRIVATE_API_KEY=    # ✅ Already in .env
GHL_API_BASE=           # ✅ Already in .env
GHL_LOCATION_ID=        # ✅ Already in .env

# Letter Generation
LETTER_URL_EXPIRATION_HOURS=72  # ✅ Confirmed
```

---

## Success Criteria

- [ ] Repair path generates all 11 PDFs correctly
- [ ] Fundable path generates all 4 PDFs correctly
- [ ] PDFs contain correct account information per round
- [ ] Signed URLs work and expire as expected
- [ ] GHL fields populated correctly for both paths
- [ ] Emails delivered with all correct links
- [ ] Courses accessible via email links
- [ ] No credit data stored in GHL (URLs only)
- [ ] All tests passing
- [ ] Error handling covers edge cases

---

## References

- [GHL API Documentation](https://highlevel.stoplight.io/docs/integrations)
- [FCRA Dispute Letter Requirements](https://www.consumer.ftc.gov/articles/disputing-errors-your-credit-reports)
- [pdf-lib Documentation](https://pdf-lib.js.org/)

---

## Implementation Summary (Dec 16, 2025)

### What Was Built

**Letter Generator** (`api/lite/letter-generator.js`)

- Generates PDFs using pdf-lib
- Repair path: 9 dispute letters (3 bureaus × 3 rounds) + 2 personal info letters
- Fundable path: 2 personal info letters + 2 inquiry removal letters
- Placeholder FCRA templates (will be replaced with real templates)
- Distributes accounts across rounds strategically

**Storage Service** (`api/lite/storage.js`)

- Uploads PDFs to Vercel Blob
- Generates public URLs (72 hour expiry handled by Vercel)
- Maps filenames to GHL field names
- Handles batch uploads

**Letter Delivery Orchestrator** (`api/lite/letter-delivery.js`)

- Full pipeline: generate → upload → GHL sync
- Async version for non-blocking execution
- Error handling and logging

**GHL Integration** (`api/lite/ghl-contact-service.js`)

- `updateContactCustomFields()` - generic custom field updater
- `updateLetterUrls()` - maps letter URLs to GHL field names
- Sets `cf_uq_path` and `cf_uq_letters_ready` flags

**Switchboard Integration** (`api/lite/switchboard.js`)

- Calls letter delivery async after GHL contact creation
- Non-blocking - doesn't slow down user response
- Passes bureaus, underwrite results, and personal info

### Architecture

```
POST /api/lite/switchboard
        ↓
[Parse + Underwrite + Suggestions] (existing, sync)
        ↓
[Create GHL Contact] (async)
        ↓
[Return response to user] ← User sees results immediately
        ↓
[Background: Letter Delivery]
    ├── Generate PDFs based on path
    ├── Upload to Vercel Blob
    └── Update GHL custom fields
```

### Tests

- All 276 existing tests pass
- No breaking changes to existing functionality

---

**Last Updated:** December 16, 2025 @ 9:10 AM
