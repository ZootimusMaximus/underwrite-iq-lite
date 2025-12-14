# UnderwriteIQ Lite - API Backend

This is the backend API that powers the FundHub Credit Analyzer.

---

## Folder Structure

Both repos should be in the same parent folder:

```
your-folder/
├── underwrite-iq-lite/    <-- this repo (API)
└── fundhub-website-GHL/   <-- frontend repo
```

---

## Prerequisites

Before you start, make sure you have:

1. **Node.js 22** installed - [Download here](https://nodejs.org/)
2. **Vercel CLI** installed - Run: `npm install -g vercel`

To check if you have them:

```bash
node --version    # Should show v22.x.x
vercel --version  # Should show a version number
```

---

## First Time Setup

Open Terminal and run these commands:

```bash
# 1. Go to the project folder
cd underwrite-iq-lite

# 2. Install dependencies (only needed once, or after pulling new code)
npm install
```

---

## Running Locally

```bash
# Make sure you're in the underwrite-iq-lite folder
npm run dev
```

You should see:

```
Vercel CLI XX.X.X
> Ready! Available at http://localhost:3000
```

**Keep this terminal window open while testing.**

---

## Testing the API

Once running, you can test it by opening this URL in your browser:

```
http://localhost:3000/api/lite/health
```

You should see: `{"ok":true}`

---

## Environment Variables

The API needs certain secrets to work. These are stored in `.env.local`.

**DO NOT share or commit this file.**

If you need to update environment variables for production, do it in the Vercel dashboard.

---

## Common Commands

| Command        | What it does       |
| -------------- | ------------------ |
| `npm run dev`  | Start local server |
| `npm test`     | Run tests          |
| `npm run lint` | Check code style   |

---

## Troubleshooting

### "Command not found: vercel"

Run: `npm install -g vercel`

### "Node version not supported"

Install Node.js 22 from https://nodejs.org/

### API returns errors

Check that `.env.local` exists and has all required keys.

---

## Project Structure

```
underwrite-iq-lite/
├── api/lite/           # API endpoints
│   ├── switchboard.js  # Main analyzer endpoint
│   ├── parse-report.js # Credit report parser
│   └── ...
├── .env.local          # Secrets (don't share!)
└── package.json        # Dependencies
```
