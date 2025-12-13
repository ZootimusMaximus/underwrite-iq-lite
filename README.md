# Underwrite IQ LITE (FundHub)

![Tests](https://github.com/YOUR_USERNAME/underwrite-iq-lite/actions/workflows/test.yml/badge.svg)
![Deploy Staging](https://github.com/YOUR_USERNAME/underwrite-iq-lite/actions/workflows/deploy-staging.yml/badge.svg)
![Deploy Production](https://github.com/YOUR_USERNAME/underwrite-iq-lite/actions/workflows/deploy-production.yml/badge.svg)

Minimal functional build:
- **/public/analyzer.html** – upload & analyze (calls API)
- **/public/funding-approved.html** – positive path
- **/public/fix-my-credit.html** – repair path
- **/pages/api/lite/** – validate & parse endpoints

## Run locally
```bash
npm install
npm run dev
# open http://localhost:3000/analyzer.html
```

## Testing

### Run Unit Tests
```bash
npm test
```

This runs all unit tests using Node.js native test framework:
- Credit ingestion tests (`credit-ingestion.test.js`)
- Deduplication store tests (`dedupe-store.test.js`)

### Run E2E Tests

E2E tests for the switchboard endpoint require a running test server:

```bash
# Terminal 1: Start test server
npm run dev:test

# Terminal 2: Run e2e tests
npm run test:e2e
```

The test server (`test-server.js`) runs the API endpoints locally without requiring Vercel CLI authentication.

The E2E tests validate:
- Full switchboard API flow (PDF upload → parsing → underwriting → response)
- Response structure matches what `tester.html` expects
- Multi-file upload handling
- File size validation

### Test Files
- `api/lite/__tests__/credit-ingestion.test.js` - Credit report parsing logic
- `api/lite/__tests__/dedupe-store.test.js` - Redis deduplication caching
- `api/lite/__tests__/switchboard.e2e.test.js` - E2E tests for switchboard endpoint

## CI/CD

### Local CI Validation

Before pushing to GitHub, validate your changes locally:

```bash
./scripts/validate-ci.sh
```

This script simulates the GitHub Actions pipeline and runs:
- ✅ Dependency installation
- ✅ Unit tests
- ✅ E2E tests with test server

### Automated Testing

Tests run automatically on GitHub Actions for:
- **Branches**: `main`, `staging`, `feature/*`, `fix/*`, `update/*`, `deploy/*`
- **Pull Requests**: To any of the above branches

The CI pipeline runs:
1. ✅ **Unit Tests** - All business logic tests
2. ✅ **E2E Tests** - Full API integration tests

### Deployment Workflows

- **Staging**: Automatically deploys to staging when pushing to `staging` branch (after tests pass)
- **Production**: Automatically deploys to production when pushing to `main` branch (after tests pass)

### Setting Up CI/CD

1. **GitHub Secrets** (for Vercel deployment):
   - `VERCEL_TOKEN` - Vercel deployment token
   - `VERCEL_ORG_ID` - Your Vercel organization ID
   - `VERCEL_PROJECT_ID` - Your project ID

2. **Branch Protection** (recommended):
   - Require status checks before merging
   - Require tests to pass: Unit Tests + E2E Tests

See [`.github/workflows/README.md`](.github/workflows/README.md) for detailed CI/CD documentation.
