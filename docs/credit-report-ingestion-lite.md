# Credit Report Ingestion (Lite)

This module (`api/lite/credit-ingestion.js`) adds a lightweight, non-LLM parser that can ingest single-bureau reports, tri-merge PDFs, and AnnualCreditReport.com disclosures. It is intended as a fast classifier/splitter around the existing single-bureau parser without changing its internals.

## Detection Rules
- **Tri-merge**: triggered when the text contains all three bureau names (`Equifax`, `Experian`, `TransUnion`). The text is sliced from the first index of each bureau name, parsed per slice, and each slice is flagged as `derivedFromMerged: true` with a shared `mergedDocumentId` (SHA-256 of the merged text).
- **Annual disclosure**: triggered when the text contains `AnnualCreditReport` or `AnnualCreditReport.com` (case-insensitive). Parsed as a single bureau; if no score is found `scoreDetails.available` is set to `false`.
- **Single bureau**: default path when the above markers are absent.

If tri-merge detection fires but fewer than two boundaries can be built, ingestion falls back to a single-bureau parse and records the `tri_merge_detection_failed` warning on the bureau object.

## Output Shape
Each bureau object retains the original single-bureau fields plus:

- `sourceType`: `single_bureau | tri_merge | annual_disclosure`
- `derivedFromMerged`: `true` for tri-merge slices
- `mergedDocumentId`: SHA-256 of the merged text (tri-merge only)
- `parsingWarnings`: string array (optional)
- `scoreDetails`: `{ value, available }` mirror of the numeric `score`

`enforceBureauSlots(existing, incoming)` maintains at most three distinct bureau entries, only replacing an existing bureau when the incoming `reportDate` is strictly newer (ISO or parseable). Rejections are returned with reasons `stale_report` or `max_bureaus_reached`.

## Entry Point
`ingestCreditReport(buffer, { textOverride? })` extracts text (or uses the override), normalizes whitespace, applies detection, and returns `{ bureaus, sourceType, rejected? }`. The helper accepts a `textOverride` to support tests while keeping the PDF ingestion path intact.
