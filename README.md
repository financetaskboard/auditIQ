# Odoo Attachment Audit Portal

Find posted journal entries **missing attachments** in Odoo — replaces a tedious manual process.

```
Manual:  Accounting → P&L → Expense → General Entries → Journal Entry → check attachment section
This tool: Select date range → Click Fetch → See all missing entries + direct links to fix them
```

---

## Deploy on Render (Cloud — Recommended)

### Step 1 — Push this repo to your GitHub

### Step 2 — Create a new Web Service on Render

- Go to https://dashboard.render.com → **New → Web Service**
- Connect your GitHub repo

### Step 3 — Set build & start commands

| Field | Value |
|-------|-------|
| **Build Command** | `npm install` |
| **Start Command** | `node attachment-server.js` |
| **Instance Type** | Free |

### Step 4 — Add Environment Variables

Go to your Render service → **Environment** tab → Add:

| Key | Value |
|-----|-------|
| `ODOO_URL` | `https://yourcompany.odoo.com/` |
| `ODOO_DB` | `your-database-name` |
| `ODOO_USERNAME` | `admin@yourcompany.com` |
| `ODOO_API_KEY` | your Odoo API key or login password |

> **Get an API key:** Odoo → Settings → Technical → API Keys → New

### Step 5 — Deploy & open your live URL

Once deployed Render gives you a URL like `https://odoo-attachment-audit.onrender.com`

> ⚠ **Free tier note:** Free instances sleep after ~15 min inactivity. First request after sleep takes ~30 sec to wake up.

---

## Run Locally

```bash
git clone https://github.com/financetaskboard/auditIQ.git
cd auditIQ
npm install
cp odoo-settings.example.json odoo-settings.json
# Edit odoo-settings.json with your credentials
npm start
# Open http://localhost:3002
```

**Windows:** Double-click `START-SERVER.bat`

---

## How It Works

```
Browser  ←→  Node.js server (same origin)  ←→  Odoo JSON-RPC
```

1. Resolves account IDs from `account.account` (based on Scope filter)
2. Finds posted `account.move.line` entries in the date range
3. Reads `account.move` records in batches
4. Checks `ir.attachment` for each move
5. Returns moves with **zero attachments**

---

## Environment Variables (for Render)

| Variable | Description |
|----------|-------------|
| `ODOO_URL` | Full Odoo URL with trailing slash |
| `ODOO_DB` | Database name |
| `ODOO_USERNAME` | Login email |
| `ODOO_API_KEY` | API key or password |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Render deploy fails | Build: `npm install` · Start: `node attachment-server.js` |
| Authentication failed | Re-check env vars — no extra spaces |
| No entries shown | Widen date range or change Scope to "All Accounts" |
| Open in Odoo link broken | Ensure `ODOO_URL` ends with `/` |

---

## Requirements

- Node.js 16+ · Odoo 15/16/17
- Odoo user with read access to `account.move`, `account.move.line`, `ir.attachment`, `account.account`

MIT License
