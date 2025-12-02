# 30-Day Deduplication

The switchboard now short-circuits repeat submissions for 30 days using Upstash Redis. Only hashed identifiers and redirect payloads are stored; raw email/phone are never persisted.

## Keys
- User key: `uwiq:u:<sha256(email|digits)>` (email is lowercased/trimmed; phone is digits-only)
- Device key: `uwiq:d:<deviceId>` (client-generated, persisted in localStorage)
- Ref key: `uwiq:r:<refId>` (refId sent to clients for cross-device identity and affiliate attribution)

Redis TTL is set to **2592000 seconds (30 days)** for all keys.

## Flow
1. Build dedupe keys from the incoming form (`email`, `phone`, `deviceId`) and derive `refId` (hash-based). A ref key is stored for cross-device lookups.
2. Lookup order: user key, then device key, then ref key.
3. If a redirect payload is found, return `{ ok: true, redirect, deduped: true }` without reprocessing.
4. Otherwise run the normal underwriting pipeline, then cache the redirect payload at all keys with the 30-day TTL and return `{ ok: true, redirect, deduped: false }`.

## Environment
`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` must be set to enable caching. When missing, the pipeline continues without dedupe rather than failing.

Optional referral stats: `GHL_PRIVATE_API_KEY` (Bearer key) and `GHL_API_BASE` (defaults to `https://services.leadconnectorhq.com`).

## Clearing Locks
Deleting either the user key or device key in Redis immediately allows a fresh submission. Because only hashed identifiers are stored, there is no PII in the cache.

## Redirect Payload (cached)
```json
{
  "resultType": "funding | repair",
  "resultUrl": "https://fundhub.ai/success/XYZ",
  "suggestions": [{ "title": "string", "description": "string" }],
  "lastUpload": "2025-02-01T12:45:00.000Z",
  "daysRemaining": 23,
  "refId": "<contactId>",
  "affiliateLink": "https://fundhub.ai/credit-analyzer.html?ref=<contactId>"
}
```
This payload is returned on dedupe hits and is stored under the user/device/ref keys with the 30-day TTL.

## API surfaces
- `GET /api/lite/referral-lookup?ref=<refId>` — returns the cached redirect payload for cross-device/dashboard loads.
- `GET /api/lite/affiliate-stats?ref=<refId>` — fetches tiered earnings/referral counts from GHL (falls back to zeros with a soft warning when unavailable).
