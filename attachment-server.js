/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║     ATTACHMENT AUDIT PORTAL — Odoo Local Proxy  v1.0        ║
 * ║   Runs on http://localhost:3002                              ║
 * ║   Purpose: Find Journal Entries with missing attachments     ║
 * ║   Flow: P&L → Expense Accounts → Journal Entries → Audit    ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = 3002;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// ── Settings (reuses same odoo-settings.json) ──────────────────
const SETTINGS_FILE = path.join(__dirname, 'odoo-settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (e) {}
  return {};
}
function saveSettings(data) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
}

// ── Odoo Auth ──────────────────────────────────────────────────
async function odooAuthenticate(url, db, username, password) {
  const baseUrl = url.replace(/\/$/, '');
  const resp = await fetch(`${baseUrl}/web/session/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call', id: 1,
      params: { db, login: username, password }
    })
  });
  const data = await resp.json();
  if (!data.result || !data.result.uid || data.result.uid === false) {
    const msg = data.result?.message || data.error?.data?.message || 'Invalid credentials';
    throw new Error(`Authentication failed: ${msg}`);
  }
  return { uid: data.result.uid, cookie: resp.headers.get('set-cookie') || '', baseUrl };
}

// ── Odoo call_kw ───────────────────────────────────────────────
async function odooCall(session, model, method, args = [], kwargs = {}) {
  const resp = await fetch(`${session.baseUrl}/web/dataset/call_kw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(session.cookie ? { Cookie: session.cookie } : {})
    },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call', id: Math.floor(Math.random() * 99999),
      params: { model, method, args, kwargs: { context: { lang: 'en_IN' }, ...kwargs } }
    })
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.data?.message || data.error.message);
  return data.result;
}

// ── GET /health ────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', server: 'Attachment Audit Proxy v1', port: PORT, time: new Date().toISOString() });
});

// ── GET /api/settings ──────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  const s = loadSettings();
  res.json({ ...s, apiKey: s.apiKey ? '••••••••' : '' });
});

// ── POST /api/settings ─────────────────────────────────────────
app.post('/api/settings', (req, res) => {
  try {
    const s = loadSettings();
    const incoming = req.body;
    if (incoming.apiKey === '••••••••') delete incoming.apiKey;
    saveSettings({ ...s, ...incoming });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/test ─────────────────────────────────────────────
app.post('/api/test', async (req, res) => {
  const s = { ...loadSettings(), ...req.body };
  if (req.body.apiKey === '••••••••') s.apiKey = loadSettings().apiKey;
  try {
    const session = await odooAuthenticate(s.url, s.db, s.username, s.apiKey);

    // Quick count of journal entries
    const count = await odooCall(session, 'account.move', 'search_count',
      [[['move_type', '=', 'entry'], ['state', '=', 'posted']]]
    );

    res.json({
      ok: true,
      uid: session.uid,
      message: 'Connection successful!',
      journalEntryCount: count,
      note: `✅ Connected — ${count} posted journal entries in Odoo`
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── POST /api/sync/missing-attachments ────────────────────────
// Core endpoint: finds all posted journal entries in date range
// that touch expense/P&L accounts and have ZERO attachments.
//
// Body params:
//   dateFrom    — "YYYY-MM-DD"
//   dateTo      — "YYYY-MM-DD"
//   accountScope — "expense" | "all_pl" | "all"
//   entryType   — "entry" | "in_invoice" | "all"
app.post('/api/sync/missing-attachments', async (req, res) => {
  const s = loadSettings();
  const {
    dateFrom,
    dateTo,
    accountScope = 'expense',
    entryType    = 'entry'
  } = req.body;

  if (!dateFrom || !dateTo) {
    return res.status(400).json({ ok: false, error: 'dateFrom and dateTo are required' });
  }

  console.log(`\n📎 Attachment Audit | ${dateFrom} → ${dateTo} | scope=${accountScope} | type=${entryType}`);

  try {
    const session = await odooAuthenticate(s.url, s.db, s.username, s.apiKey);

    // ── Step 1: Resolve target account IDs ──────────────────────
    const expenseTypes = ['expense', 'expense_direct_cost', 'expense_depreciation'];
    const incomeTypes  = ['income', 'income_other'];

    let accountDomain = [['deprecated', '=', false]];
    if (accountScope === 'expense') {
      accountDomain.push(['account_type', 'in', expenseTypes]);
    } else if (accountScope === 'all_pl') {
      accountDomain.push(['account_type', 'in', [...expenseTypes, ...incomeTypes]]);
    }
    // accountScope === 'all' → no account_type filter (all accounts)

    const accounts = await odooCall(session, 'account.account', 'search_read',
      [accountDomain],
      { fields: ['id', 'code', 'name', 'account_type'], limit: 5000 }
    );

    const accountMap = {};
    accounts.forEach(a => { accountMap[a.id] = a; });
    const accountIds = accounts.map(a => a.id);

    console.log(`  ✅ ${accountIds.length} accounts matched (scope=${accountScope})`);
    if (accountIds.length === 0) {
      return res.json({ ok: true, total: 0, missing: 0, with_attachment: 0, data: [], accountsChecked: 0 });
    }

    // ── Step 2: Get move.line entries in date range ──────────────
    const lineDomain = [
      ['account_id', 'in', accountIds],
      ['date', '>=', dateFrom],
      ['date', '<=', dateTo],
      ['parent_state', '=', 'posted']
    ];
    if (entryType !== 'all') {
      lineDomain.push(['move_id.move_type', '=', entryType]);
    }

    const moveLines = await odooCall(session, 'account.move.line', 'search_read',
      [lineDomain],
      { fields: ['move_id', 'account_id', 'debit', 'credit', 'name'], limit: 100000, context: { lang: 'en_IN', allowed_company_ids: [] } }
    );

    if (moveLines.length === 0) {
      return res.json({ ok: true, total: 0, missing: 0, with_attachment: 0, data: [], accountsChecked: accountIds.length,
        message: `No posted entries found in ${dateFrom} → ${dateTo}` });
    }

    // ── Step 3: Aggregate per move ───────────────────────────────
    const moveAgg = {};
    moveLines.forEach(l => {
      const mid = l.move_id?.[0];
      if (!mid) return;
      if (!moveAgg[mid]) {
        moveAgg[mid] = { accounts: new Set(), total_debit: 0, total_credit: 0, line_narrations: new Set() };
      }
      moveAgg[mid].accounts.add(l.account_id?.[0]);
      moveAgg[mid].total_debit  += l.debit  || 0;
      moveAgg[mid].total_credit += l.credit || 0;
      if (l.name && l.name.trim() && l.name !== '/') moveAgg[mid].line_narrations.add(l.name.trim());
    });

    const moveIds = Object.keys(moveAgg).map(Number);
    console.log(`  ✅ ${moveIds.length} unique journal entries`);

    // ── Step 4: Fetch full move details in batches of 1000 ───────
    const allMoves = [];
    for (let i = 0; i < moveIds.length; i += 1000) {
      const batch = await odooCall(session, 'account.move', 'search_read',
        [[['id', 'in', moveIds.slice(i, i + 1000)]]],
        {
          fields: ['id', 'name', 'date', 'ref', 'narration', 'partner_id',
                   'journal_id', 'move_type', 'amount_total'],
          limit: 1000,
          context: { lang: 'en_IN', allowed_company_ids: [] }
        }
      );
      allMoves.push(...batch);
    }

    // ── Step 5: Check attachments in batches of 1000 ─────────────
    const attachedIds = new Set();
    for (let i = 0; i < moveIds.length; i += 1000) {
      const atts = await odooCall(session, 'ir.attachment', 'search_read',
        [[['res_model', '=', 'account.move'], ['res_id', 'in', moveIds.slice(i, i + 1000)]]],
        { fields: ['res_id', 'name'], limit: 100000 }
      );
      atts.forEach(a => attachedIds.add(a.res_id));
    }

    console.log(`  ✅ ${attachedIds.size} entries HAVE attachments`);
    console.log(`  ✅ ${allMoves.length - attachedIds.size} entries MISSING attachments`);

    // ── Step 6: Build output rows ─────────────────────────────────
    const missing = [];
    const withAtt = [];

    allMoves.forEach(m => {
      const extra = moveAgg[m.id] || {};
      const accountDetails = [...(extra.accounts || [])]
        .map(aid => accountMap[aid]).filter(Boolean)
        .sort((a, b) => (a.code || '').localeCompare(b.code || ''));

      // Amount = max of total debit / credit (the JE total)
      const amount = Math.round(
        Math.max(extra.total_debit || 0, extra.total_credit || 0) * 100
      ) / 100;

      const narration = m.narration
        || [...(extra.line_narrations || [])].slice(0, 2).join('; ')
        || '';

      // Entry type label
      const typeLabel = {
        entry:       'Journal Entry',
        in_invoice:  'Vendor Bill',
        out_invoice: 'Customer Invoice',
        in_refund:   'Vendor Credit',
        out_refund:  'Customer Credit'
      }[m.move_type] || m.move_type || 'Journal Entry';

      const row = {
        odoo_id:      m.id,
        entry_no:     m.name    || '',
        date:         m.date    || '',
        ref:          m.ref     || '',
        narration:    narration.substring(0, 120),
        partner:      m.partner_id?.[1] || '',
        journal:      m.journal_id?.[1] || '',
        move_type:    m.move_type || 'entry',
        type_label:   typeLabel,
        amount,
        accounts_csv: accountDetails.map(a => `${a.code} - ${a.name}`).join(' | '),
        has_attachment: attachedIds.has(m.id)
      };

      if (attachedIds.has(m.id)) withAtt.push(row);
      else missing.push(row);
    });

    // Sort missing by date descending
    missing.sort((a, b) => b.date.localeCompare(a.date));
    missing.forEach((r, i) => { r.id = i + 1; });

    res.json({
      ok: true,
      total:            allMoves.length,
      missing:          missing.length,
      with_attachment:  withAtt.length,
      accounts_checked: accountIds.length,
      data:             missing
    });

  } catch (e) {
    console.error('❌ Attachment audit error:', e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── GET /api/journals — for filter dropdown ────────────────────
app.get('/api/journals', async (req, res) => {
  const s = loadSettings();
  try {
    const session = await odooAuthenticate(s.url, s.db, s.username, s.apiKey);
    const journals = await odooCall(session, 'account.journal', 'search_read',
      [[]],
      { fields: ['id', 'name', 'type', 'code'], limit: 500, order: 'name asc' }
    );
    res.json({ ok: true, data: journals });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── Serve Portal HTML ──────────────────────────────────────────
const portalFile = path.join(__dirname, 'attachment-portal.html');
app.get('/', (req, res) => {
  fs.existsSync(portalFile)
    ? res.sendFile(portalFile)
    : res.send(`<h2 style="font-family:Segoe UI;padding:40px">⚠ Place attachment-portal.html in: ${__dirname}</h2>`);
});

// ── Start ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  Attachment Audit Proxy  v1.0  →  localhost:${PORT}    ║`);
  console.log(`║  Finds journal entries with MISSING attachments      ║`);
  console.log(`╠══════════════════════════════════════════════════════╣`);
  console.log(`║  GET  /health                    server check        ║`);
  console.log(`║  POST /api/test                  test Odoo login     ║`);
  console.log(`║  GET  /api/settings              load credentials    ║`);
  console.log(`║  POST /api/settings              save credentials    ║`);
  console.log(`║  POST /api/sync/missing-attachments  <── MAIN        ║`);
  console.log(`║       body: { dateFrom, dateTo,                      ║`);
  console.log(`║              accountScope, entryType }               ║`);
  console.log(`║  GET  /api/journals              journal list        ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);

  const s = loadSettings();
  if (s.url) console.log(`  Odoo: ${s.url}  DB: ${s.db}  User: ${s.username}\n`);
  else       console.log(`  ⚠ No settings — open http://localhost:${PORT} → Settings\n`);
});
