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
const PORT = process.env.PORT || 3002;

// ── Cloud detection ────────────────────────────────────────────
// On Render (or any cloud), PORT is set by the platform.
// When PORT env var is set by platform, we treat this as cloud mode
// and read credentials from env vars instead of a local file.
const IS_CLOUD = !!process.env.RENDER || !!process.env.RAILWAY_ENVIRONMENT || false;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// ── Settings ───────────────────────────────────────────────────
// Cloud (Render): reads from environment variables
// Local:          reads from odoo-settings.json file
const SETTINGS_FILE = path.join(__dirname, 'odoo-settings.json');

function loadSettings() {
  // Cloud mode — use environment variables set in Render dashboard
  if (IS_CLOUD || process.env.ODOO_URL) {
    return {
      url:      process.env.ODOO_URL      || '',
      db:       process.env.ODOO_DB       || '',
      username: process.env.ODOO_USERNAME || '',
      apiKey:   process.env.ODOO_API_KEY  || ''
    };
  }
  // Local mode — read from JSON file
  try {
    if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (e) {}
  return {};
}

function saveSettings(data) {
  if (IS_CLOUD) {
    // On cloud, settings come from env vars — can't write to disk persistently.
    // Just acknowledge; user must update env vars in Render dashboard.
    console.warn('⚠  Running on cloud — settings saved in-memory only. Update env vars in Render dashboard for permanent changes.');
    return;
  }
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
  res.json({ status: 'ok', server: 'Attachment Audit Proxy v1', port: PORT, cloudMode: IS_CLOUD, time: new Date().toISOString() });
});

// ── GET /api/settings ──────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  const s = loadSettings();
  res.json({ ...s, apiKey: s.apiKey ? '••••••••' : '', cloudMode: IS_CLOUD });
});

// ── POST /api/settings ─────────────────────────────────────────
app.post('/api/settings', (req, res) => {
  try {
    if (IS_CLOUD) {
      return res.json({ ok: true, cloudMode: true, message: 'Running on cloud — update credentials via Render environment variables (ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY).' });
    }
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

    // ── Excluded accounts (no attachment required for these) ─────
    // These are system/payroll/tax accounts where supporting docs
    // are generated automatically or are not applicable.
    const EXCLUDED_CODES = new Set([
      '410003', // Bad Debts Written Off
      '410004', // Bank Charges
      '410010', // Cleaning & Washing
      '410013', // Conveyance
      '410016', // Discount
      '410017', // Donation U/s 80G (CSR)
      '410021', // General Expense
      '410022', // Gratuity
      '410026', // Interest Expense
      '410028', // Leave Encashment Expenses
      '410031', // Motor Car Petrol Expenses
      '410033', // Performance Incentive/Variable
      '410038', // Rates and Taxes
      '410042', // Salary - PF Admin Charges
      '410044', // Employer Contribution to PF
      '410046', // Salary Expense
      '410053', // Diwali Bonus/Gift
      '410058', // Travelling - Implementation
      '410060', // Travelling - Sales
      '410063', // Travelling Expense
      '410071', // Staff Welfare
      '410072', // Profit/Loss on Foreign Transaction
      '410075', // Tax Expenses
      '410077', // ESI Employer Contribution
      '410088', // Misc Expenses
      '410095', // Provision for Investment Write off
      '410101', // PT Annual Fees
      '410102', // PF Damages
      '410103', // Salary Expense-EMG
      '410104', // Salary Expenses-BT
      '410106', // Performance Incentive/Variable-EMG
      '410107', // Employer Contribution to PF-BT
      '410108', // Salary - PF Admin Charges-BT
      '410110', // Leave Encashment Expenses-BT
      '410111', // Gratuity-BT
      // ── Balance Sheet / Payable accounts to exclude ──
      '130003', // Staff Expenses Payable
    ]);

    let accountDomain = [['deprecated', '=', false]];
    if (accountScope === 'expense') {
      accountDomain.push(['account_type', 'in', expenseTypes]);
    } else if (accountScope === 'all_pl') {
      accountDomain.push(['account_type', 'in', [...expenseTypes, ...incomeTypes]]);
    }
    // accountScope === 'all' → no account_type filter (all accounts)

    const allAccounts = await odooCall(session, 'account.account', 'search_read',
      [accountDomain],
      { fields: ['id', 'code', 'name', 'account_type'], limit: 5000 }
    );

    // Filter out excluded accounts
    const accounts = allAccounts.filter(a => !EXCLUDED_CODES.has((a.code || '').trim()));
    const excludedCount = allAccounts.length - accounts.length;
    if (excludedCount > 0) {
      console.log(`  ⏭  ${excludedCount} accounts excluded (payroll/tax/system accounts)`);
    }

    const accountMap = {};
    accounts.forEach(a => { accountMap[a.id] = a; });
    const accountIds = accounts.map(a => a.id);

    console.log(`  ✅ ${accountIds.length} accounts matched (scope=${accountScope}, excluded=${excludedCount})`);
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
    // allLineAccountInfo captures every account seen in move lines
    // (including BS/liability accounts not in our accountMap)
    const allLineAccountInfo = {}; // id → { id, name }
    const moveAgg = {};
    moveLines.forEach(l => {
      const mid = l.move_id?.[0];
      const aid = l.account_id?.[0];
      if (!mid) return;
      if (!moveAgg[mid]) {
        moveAgg[mid] = { accounts: new Set(), total_debit: 0, total_credit: 0, line_narrations: new Set() };
      }
      moveAgg[mid].accounts.add(aid);
      moveAgg[mid].total_debit  += l.debit  || 0;
      moveAgg[mid].total_credit += l.credit || 0;
      if (l.name && l.name.trim() && l.name !== '/') moveAgg[mid].line_narrations.add(l.name.trim());
      // Capture account name from move line (Odoo returns [id, display_name])
      if (aid && !allLineAccountInfo[aid]) {
        allLineAccountInfo[aid] = { id: aid, name: l.account_id?.[1] || String(aid) };
      }
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
      const allAccountIds = [...(extra.accounts || [])];

      // Expense/P&L accounts — those in our filtered accountMap
      const expenseAccounts = allAccountIds
        .filter(aid => accountMap[aid])
        .map(aid => accountMap[aid])
        .sort((a, b) => (a.code || '').localeCompare(b.code || ''));

      // Balance Sheet accounts — all others (Creditors, GST payable, etc.)
      const bsAccounts = allAccountIds
        .filter(aid => !accountMap[aid] && allLineAccountInfo[aid])
        .map(aid => allLineAccountInfo[aid])
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

      // Amount = max of total debit / credit (the JE total)
      const amount = Math.round(
        Math.max(extra.total_debit || 0, extra.total_credit || 0) * 100
      ) / 100;

      // bill_ref  = Bill Reference field (vendor's own invoice/ref number, m.ref in Odoo)
      // narration = Narration field only (internal description, m.narration in Odoo)
      // These are kept strictly separate — never merged or used as fallback for each other
      const billRef   = (m.ref      || '').trim();
      const narration = (m.narration || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim().substring(0, 150);

      // Entry type label
      const typeLabel = {
        entry:       'Journal Entry',
        in_invoice:  'Vendor Bill',
        out_invoice: 'Customer Invoice',
        in_refund:   'Vendor Credit',
        out_refund:  'Customer Credit'
      }[m.move_type] || m.move_type || 'Journal Entry';

      const row = {
        odoo_id:          m.id,
        entry_no:         m.name    || '',
        date:             m.date    || '',
        bill_ref:         billRef,
        narration:        narration,
        partner:          m.partner_id?.[1] || '',
        journal:          m.journal_id?.[1] || '',
        move_type:        m.move_type || 'entry',
        type_label:       typeLabel,
        amount,
        expense_accounts: expenseAccounts.map(a => `${a.code} - ${a.name}`).join(' | '),
        bs_accounts:      bsAccounts.map(a => a.name).join(' | '),
        accounts_csv:     expenseAccounts.map(a => `${a.code} - ${a.name}`).join(' | '),
        has_attachment:   attachedIds.has(m.id)
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
      accounts_excluded: excludedCount,
      data:             missing
    });

  } catch (e) {
    console.error('❌ Attachment audit error:', e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
});


// ── POST /api/sync/vendor-pattern ────────────────────────────
// Month-wise recurring expense pattern per vendor.
// Helps identify missing entries for regular vendors before month close.
app.post('/api/sync/vendor-pattern', async (req, res) => {
  const s = loadSettings();
  const { dateFrom, dateTo, accountScope = 'expense', minMonths = 2 } = req.body;
  if (!dateFrom || !dateTo) return res.status(400).json({ ok: false, error: 'dateFrom and dateTo are required' });

  console.log('\n📊 Vendor Pattern | ' + dateFrom + ' → ' + dateTo);
  try {
    const session = await odooAuthenticate(s.url, s.db, s.username, s.apiKey);

    const EXCL = new Set(['410003','410004','410010','410013','410016','410017','410021','410022',
      '410026','410028','410031','410033','410038','410042','410044','410046','410053','410058',
      '410060','410063','410071','410072','410075','410077','410088','410095','410101','410102',
      '410103','410104','410106','410107','410108','410110','410111','130003']);

    const expenseTypes = ['expense','expense_direct_cost','expense_depreciation'];
    const incomeTypes  = ['income','income_other'];
    let accountDomain  = [['deprecated','=',false]];
    if (accountScope === 'expense') accountDomain.push(['account_type','in',expenseTypes]);
    else if (accountScope === 'all_pl') accountDomain.push(['account_type','in',[...expenseTypes,...incomeTypes]]);

    const allAccounts = await odooCall(session,'account.account','search_read',
      [accountDomain],{ fields:['id','code','name'], limit:5000 });
    const accountIds = allAccounts.filter(a => !EXCL.has((a.code||'').trim())).map(a => a.id);
    if (!accountIds.length) return res.json({ ok:true, months:[], vendors:[] });

    // Fetch posted vendor bills/entries with a partner
    const bills = await odooCall(session,'account.move','search_read',
      [[['move_type','in',['in_invoice','in_refund']],['state','=','posted'],
        ['invoice_date','>=',dateFrom],['invoice_date','<=',dateTo],['partner_id','!=',false]]],
      { fields:['id','name','invoice_date','partner_id','amount_total','move_type'],
        limit:50000, order:'invoice_date asc', context:{lang:'en_IN',allowed_company_ids:[]} }
    );

    // Filter to bills that actually touch expense accounts
    const billIds = bills.map(b => b.id);
    const relevantIds = new Set();
    for (let i = 0; i < billIds.length; i += 2000) {
      const lines = await odooCall(session,'account.move.line','search_read',
        [[['move_id','in',billIds.slice(i,i+2000)],['account_id','in',accountIds]]],
        { fields:['move_id'], limit:100000 });
      lines.forEach(l => relevantIds.add(l.move_id?.[0]));
    }
    const relevantBills = bills.filter(b => relevantIds.has(b.id));

    // Build months list
    const months = [];
    const cur = new Date(dateFrom.substring(0,7)+'-01');
    const end = new Date(dateTo.substring(0,7)+'-01');
    while (cur <= end) { months.push(cur.toISOString().substring(0,7)); cur.setMonth(cur.getMonth()+1); }

    // Group by vendor x month
    const vendorMap = {};
    relevantBills.forEach(b => {
      const pid   = b.partner_id?.[0];
      const pname = b.partner_id?.[1] || 'Unknown';
      const month = (b.invoice_date||'').substring(0,7);
      if (!pid || !month) return;
      if (!vendorMap[pid]) vendorMap[pid] = { partner_id:pid, partner_name:pname, monthly:{} };
      if (!vendorMap[pid].monthly[month]) vendorMap[pid].monthly[month] = { count:0, amount:0 };
      vendorMap[pid].monthly[month].count++;
      vendorMap[pid].monthly[month].amount += Math.abs(b.amount_total||0);
    });

    const vendors = Object.values(vendorMap)
      .map(v => {
        const active  = months.filter(m => v.monthly[m]);
        const missing = months.filter(m => !v.monthly[m]);
        const total   = active.reduce((s,m) => s + (v.monthly[m]?.amount||0), 0);
        return { ...v, active_months:active.length, missing_months:missing,
          has_gaps: missing.length > 0 && active.length > 0,
          total_amount: Math.round(total*100)/100,
          avg_monthly:  active.length ? Math.round(total/active.length) : 0 };
      })
      .filter(v => v.active_months >= minMonths)
      .sort((a,b) => b.missing_months.length - a.missing_months.length || b.total_amount - a.total_amount);

    console.log('  ✅ ' + vendors.length + ' recurring vendors | ' + vendors.filter(v=>v.has_gaps).length + ' have gaps');
    res.json({ ok:true, months, vendors, total_vendors:vendors.length, vendors_with_gaps:vendors.filter(v=>v.has_gaps).length });

  } catch(e) {
    console.error('❌ Vendor pattern error:', e.message);
    res.status(400).json({ ok:false, error:e.message });
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
  console.log(`║  Attachment Audit Proxy  v1.0  →  port ${PORT}          ║`);
  console.log(`║  Mode: ${IS_CLOUD ? '☁  CLOUD (Render)                      ' : '💻 LOCAL                               '}  ║`);
  console.log(`╠══════════════════════════════════════════════════════╣`);
  console.log(`║  GET  /health                    server check        ║`);
  console.log(`║  POST /api/test                  test Odoo login     ║`);
  console.log(`║  GET  /api/settings              load credentials    ║`);
  console.log(`║  POST /api/settings              save credentials    ║`);
  console.log(`║  POST /api/sync/missing-attachments  <── MAIN        ║`);
  console.log(`║  GET  /api/journals              journal list        ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);

  if (IS_CLOUD) {
    const s = loadSettings();
    if (s.url) console.log(`  ☁  Cloud mode — Odoo: ${s.url}  DB: ${s.db}\n`);
    else       console.log(`  ⚠  Cloud mode — Set env vars: ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY\n`);
  } else {
    const s = loadSettings();
    if (s.url) console.log(`  Odoo: ${s.url}  DB: ${s.db}  User: ${s.username}\n`);
    else       console.log(`  ⚠  No settings — open http://localhost:${PORT} → Settings\n`);
  }
});
