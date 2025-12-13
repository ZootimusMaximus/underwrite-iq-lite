# CI/CD Workflows

This directory contains GitHub Actions workflows for automated testing and deployment.

## Workflows

### 1. Test Suite (`test.yml`)

**Triggers:**
- Push to: `main`, `staging`, `feature/*`, `fix/*`, `update/*`, `deploy/*`
- Pull requests to the same branches

**Jobs:**
- **Unit Tests**: Runs all unit tests (credit-ingestion, dedupe-store)
- **E2E Tests**: Runs end-to-end tests for the switchboard endpoint
- **Test Summary**: Aggregates results and reports status

**What it does:**
1. Checks out code
2. Sets up Node.js 22.x
3. Installs dependencies
4. Runs unit tests
5. Starts test server
6. Runs e2e tests
7. Reports results

### 2. Deploy to Staging (`deploy-staging.yml`)

**Triggers:**
- Push to: `staging`

**What it does:**
1. Runs full test suite
2. Deploys to Vercel staging environment (if tests pass)

### 3. Deploy to Production (`deploy-production.yml`)

**Triggers:**
- Push to: `main`

**What it does:**
1. Runs full test suite
2. Deploys to Vercel production environment (if tests pass)
3. Creates release tag

## Setting Up CI/CD

### Required GitHub Secrets

If you want to enable automatic deployments to Vercel, add these secrets to your GitHub repository:

1. Go to **Settings** → **Secrets and variables** → **Actions**
2. Add the following secrets:
   - `VERCEL_TOKEN` - Your Vercel deployment token
   - `VERCEL_ORG_ID` - Your Vercel organization ID
   - `VERCEL_PROJECT_ID` - Your Vercel project ID

### Optional Secrets for Redis/External Services

If your tests require external services:
- `UPSTASH_REDIS_REST_URL` - Redis cache endpoint
- `UPSTASH_REDIS_REST_TOKEN` - Redis auth token
- Any other environment variables your app needs

## Workflow Status Badges

Add these badges to your main README.md:

```markdown
![Tests](https://github.com/YOUR_USERNAME/underwrite-iq-lite/actions/workflows/test.yml/badge.svg)
![Deploy Staging](https://github.com/YOUR_USERNAME/underwrite-iq-lite/actions/workflows/deploy-staging.yml/badge.svg)
![Deploy Production](https://github.com/YOUR_USERNAME/underwrite-iq-lite/actions/workflows/deploy-production.yml/badge.svg)
```

## Local Testing

To run the same tests locally:

```bash
# Unit tests only
npm test

# E2E tests (requires test server)
# Terminal 1:
npm run dev:test

# Terminal 2:
npm run test:e2e
```

## Debugging Failed Workflows

1. **Check test logs**: Click on the failed workflow → Select the failed job → View logs
2. **Download artifacts**: Failed test runs upload artifacts for debugging
3. **Run locally**: Reproduce the issue with the same Node.js version (22.x)

## Branch Protection Rules

Recommended branch protection for `main` and `staging`:

1. Go to **Settings** → **Branches** → **Add rule**
2. Configure:
   - ✅ Require status checks to pass before merging
   - ✅ Require branches to be up to date before merging
   - Select required checks:
     - `Unit Tests`
     - `E2E Tests`
   - ✅ Require linear history
   - ✅ Do not allow bypassing the above settings

This ensures all code is tested before it reaches production.
