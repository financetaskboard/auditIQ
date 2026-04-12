# Odoo Attachment Audit Portal

A lightweight local web app that finds **posted journal entries missing attachments** in your Odoo instance — replacing a tedious manual process.

```
Manual process:  Accounting → P&L → Expense → General Entries → Journal Entry → check attachment section
This tool does:  Select date range → Click "Fetch from Odoo" → See all missing entries instantly
```

---

## Screenshots

**Dashboard** — compliance summary with stats  
**Missing Attachments tab** — full table of entries with direct links to open each one in Odoo

---

## Architecture

```
Browser (attachment-portal.html)
        ↕  fetch calls to localhost:3002
Node.js Proxy (attachment-server.js)
        ↕  Odoo JSON-RPC API
Odoo (yourcompany.odoo.com)
```

The proxy runs locally to bypass browser CORS restrictions.

---

## Setup

### Step 1 — Install Node.js
Download from https://nodejs.org — choose the **LTS** version.

### Step 2 — Clone / download this repo

```bash
git clone https://github.com/yourname/odoo-attachment-audit.git
cd odoo-attachment-audit
```

### Step 3 — Install dependencies

```bash
npm install
```

### Step 4 — Configure Odoo credentials

Copy the example settings file:
```bash
cp odoo-settings.example.json odoo-settings.json
```

Edit `odoo-settings.json` with your Odoo details:
```json
{
  "url": "https://yourcompany.odoo.com/",
  "db": "your-database-name",
  "username": "admin@yourcompany.com",
  "apiKey": "your-api-key-or-password"
}
```

> **Get an API key:** Odoo → Settings → Technical → API Keys → New  
> Or just use your login password.

### Step 5 — Start the server

**Windows:** Double-click `START-SERVER.bat`

**Mac / Linux:**
```bash
npm start
```

### Step 6 — Open the portal

Go to → **http://localhost:3002**

---

## How to Use

1. Open the **Missing Attachments** tab
2. Set your date range (or use a quick shortcut: Today / This Week / This Month / etc.)
3. Choose **Scope** — Expense Accounts, All P&L, or All Accounts
4. Choose **Type** — Journal Entries, Vendor Bills, or All Types
5. Click **Fetch from Odoo**
6. Review the results — click the **↗ Open** icon on any row to jump directly to that entry in Odoo
7. Upload the missing document in Odoo
8. Re-run the audit to confirm compliance

---

## Filters Explained

| Filter | Options | Description |
|--------|---------|-------------|
| **Scope** | Expense Accounts | Accounts with type `expense`, `expense_direct_cost`, `expense_depreciation` |
|           | All P&L Accounts | Expense + Income accounts |
|           | All Accounts     | Every account (broadest scan) |
| **Type**  | Journal Entries  | `move_type = 'entry'` — manual JEs only |
|           | Vendor Bills     | `move_type = 'in_invoice'` |
|           | All Types        | All posted account.move records |

---

## API Endpoints

| Method | URL | Description |
|--------|-----|-------------|
| `GET`  | `/health` | Check proxy is running |
| `GET`  | `/api/settings` | Load saved credentials |
| `POST` | `/api/settings` | Save credentials |
| `POST` | `/api/test` | Test Odoo connection |
| `POST` | `/api/sync/missing-attachments` | **Main endpoint** — run the audit |
| `GET`  | `/api/journals` | List available journals |

### `/api/sync/missing-attachments` body

```json
{
  "dateFrom":     "2024-04-01",
  "dateTo":       "2024-09-30",
  "accountScope": "expense",
  "entryType":    "entry"
}
```

### Response

```json
{
  "ok":               true,
  "total":            312,
  "missing":          47,
  "with_attachment":  265,
  "accounts_checked": 84,
  "data": [
    {
      "odoo_id":      1234,
      "entry_no":     "MISC/2024/00123",
      "date":         "2024-06-15",
      "type_label":   "Journal Entry",
      "journal":      "Miscellaneous Operations",
      "partner":      "ABC Suppliers Ltd",
      "ref":          "Invoice ref 2024-X",
      "narration":    "Rent expense June",
      "accounts_csv": "6200 - Rent Expense | 1100 - Bank",
      "amount":       45000.00,
      "has_attachment": false
    }
  ]
}
```

---

## Odoo Sync Logic (How It Works)

1. **Resolve accounts** — fetches `account.account` filtered by your chosen scope
2. **Fetch move lines** — searches `account.move.line` for entries in the date range touching those accounts, `parent_state = 'posted'`
3. **Get move details** — reads full `account.move` records in batches of 1,000
4. **Check attachments** — searches `ir.attachment` where `res_model = 'account.move'` for all found move IDs
5. **Compare** — returns only the moves with zero attachments

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Proxy Offline" | Run `node attachment-server.js` in terminal |
| "Authentication failed" | Check username and API key in Settings |
| No entries shown | Widen the date range or change Scope/Type |
| "Open in Odoo" link not working | Save your Odoo URL in Settings first |
| Very slow for large date ranges | Use a narrower date range or specific account scope |

---

## Security Notes

- `odoo-settings.json` is in `.gitignore` — credentials are **never committed**
- The proxy runs only on `localhost` — not accessible from other machines
- All Odoo calls use session authentication (cookie-based) over HTTPS

---

## Requirements

- Node.js 16+
- Odoo 15, 16, or 17 (tested)
- User account with read access to `account.move`, `account.move.line`, `ir.attachment`, `account.account`

---

## License

MIT
