# Underwrite IQ Lite — Repository Guide

This project is a lightweight Vercel/Node deployment for parsing consumer credit reports with GPT-4.1, underwriting them, and returning funding/repair guidance. Public HTML pages are included for quick manual testing. Stubs are included for Google OCR and basic name/email/phone/company validators.

## Quickstart

- Prereqs: Node 22.x, npm.
- Install: `npm install`
- Run locally: `npm run dev` (via `vercel dev`)
- Open: `http://localhost:3000/prod-upload.html` for a parse-only upload UI, or `http://localhost:3000/tester.html` for the full switchboard test UI.
- Key env var: `UNDERWRITE_IQ_VISION_KEY` (OpenAI API key). Optional: `PARSE_ENDPOINT` to point switchboard at a different parse-report URL.

## API & File Map

- `api/lite/parse-report.js` — multipart upload endpoint; runs stubbed `google-ocr` before a 3-pass GPT-4.1 Vision extraction to produce strict JSON (`bureaus.{experian,equifax,transunion}` plus file metadata). Logs errors to `/tmp/uwiq-errors.log` and always returns a safe fallback shape.
- `api/lite/google-ocr.js` — placeholder stub for future Google Cloud Vision OCR; returns a note only.
- `api/lite/ai-gatekeeper.js` — cheap `gpt-4o-mini` classifier that rejects non-credit-report PDFs before the expensive Vision call.
- `api/lite/validate-reports.js` — Stage 1 structural validator: enforces PDF MIME/size, max file count (≤3), duplicate detection by hash, and rejects likely tri-merge when multiple files are uploaded.
- `api/lite/validate-upload.js` — lightweight PDF validator (size + extension) for early front-end checks.
- `api/lite/validate-name.js` — validates first/last name syntax (letters/spaces/hyphens/apostrophes).
- `api/lite/validate-email.js` — basic email syntax validator.
- `api/lite/validate-phone.js` — strips non-digits, enforces 10–15 digits; Twilio Lookup stub.
- `api/lite/validate-company.js` — minimal company name check (≥3 chars); OpenCorporates stub.
- `api/lite/underwriter.js` — pure underwriting engine (score normalization, funding potential, metrics, optimization flags).
- `api/lite/suggestions.js` — builds human-readable advice based on underwriting + LLC info.
- `api/lite/switchboard.js` — orchestrator endpoint:
  1. CORS + multipart parsing
  2. Stage 1 validation (`validate-reports`)
  3. AI gatekeeper (`ai-gatekeeper`)
  4. Calls `parse-report` for each PDF (using `PARSE_ENDPOINT` if set)
  5. Merges bureaus (no duplicates)
  6. Underwriting + suggestions + card tags
  7. Returns redirect hints for funding/repair flows
- `api/letters/generate.js` — stub letter generator using `pdf-lib` to create placeholder dispute PDFs (install `pdf-lib` if you intend to use it).
- `public/prod-upload.html` — dark minimal uploader that posts to `/api/lite/parse-report`.
- `public/tester.html` — matrix-style internal UI that posts multiple PDFs to `/api/lite/switchboard` and shows summaries/raw JSON; supports export.
- `public/index.html` — simple ping page. `public/analyzer.html` just sets `window.UNDERWRITE_API_BASE`.
- `vercel.json` — routes `api/**/*.js` through `@vercel/node` and serves `public/` as static assets.

## Example Requests

- Parse a single report:
  ```bash
  curl -X POST http://localhost:3000/api/lite/parse-report \
    -F "file=@/path/to/report.pdf"
  ```
