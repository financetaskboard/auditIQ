/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║     ODOO BOOKS AUDIT — Odoo Compliance Intelligence v2.0        ║
 * ║   Runs on http://localhost:3002                              ║
 * ║   Purpose: Odoo compliance & audit intelligence platform     ║
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
      url:           process.env.ODOO_URL           || '',
      db:            process.env.ODOO_DB            || '',
      username:      process.env.ODOO_USERNAME      || '',
      apiKey:        process.env.ODOO_API_KEY       || '',
      firebaseDbUrl: process.env.FIREBASE_DB_URL    || '',
      firebaseSecret:process.env.FIREBASE_SECRET    || ''
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
  res.json({ status: 'ok', server: 'Odoo Books Audit v2', port: PORT, cloudMode: IS_CLOUD, time: new Date().toISOString() });
});

// ── GET /api/settings ──────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  const s = loadSettings();
  res.json({
    ...s,
    apiKey:         s.apiKey          ? '••••••••' : '',
    firebaseSecret: s.firebaseSecret  ? '••••••••' : '',
    cloudMode: IS_CLOUD
  });
});

// ── POST /api/settings ─────────────────────────────────────────
app.post('/api/settings', (req, res) => {
  try {
    if (IS_CLOUD) {
      return res.json({ ok: true, cloudMode: true, message: 'Running on cloud — update credentials via Render environment variables (ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY).' });
    }
    const s = loadSettings();
    const incoming = req.body;
    if (incoming.apiKey         === '••••••••') delete incoming.apiKey;
    if (incoming.firebaseSecret === '••••••••') delete incoming.firebaseSecret;
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

  console.log(`\n📎 Missing Attachments | ${dateFrom} → ${dateTo} | scope=${accountScope} | type=${entryType}`);

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

    const LINES_TRUNCATED = moveLines.length >= 100000;
    if (LINES_TRUNCATED) {
      console.warn(`⚠ Move lines hit limit (100,000) — data may be incomplete. Consider narrowing date range.`);
    }
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

    // Sort by date descending
    missing.sort((a, b) => b.date.localeCompare(a.date));
    withAtt.sort((a, b) => b.date.localeCompare(a.date));
    missing.forEach((r, i) => { r.id = i + 1; });
    withAtt.forEach((r, i) => { r.id = i + 1; });

    res.json({
      ok: true,
      total:             allMoves.length,
      missing:           missing.length,
      with_attachment:   withAtt.length,
      accounts_checked:  accountIds.length,
      accounts_excluded: excludedCount,
      data:              missing,
      data_with_attachment: withAtt,
      truncated:         LINES_TRUNCATED,
      truncation_warning: LINES_TRUNCATED
        ? `⚠ Data may be incomplete — ${moveLines.length.toLocaleString()} lines fetched (limit hit). Split into smaller date ranges for full accuracy.`
        : null
    });

  } catch (e) {
    console.error('❌ Attachment audit error:', e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
});



// ── POST /api/attachments/download ───────────────────────────
// Downloads actual attachment files for given move IDs from Odoo.
// Returns JSON: { ok, attachments: [{ move_id, entry_no, filename, mimetype, data_b64 }] }
// Client-side uses JSZip to bundle into a ZIP for download.
//
// FIX 1 — Limit raised from 100 → 500 to match the frontend batch size.
//          Old cap of 100 silently left entries 101-N unprocessed, making
//          them all appear as "ghost attachments" even when files existed.
//
// FIX 2 — datas field is now fetched via a separate read() call per batch
//          instead of inside search_read(). In Odoo 16+, search_read()
//          returns datas=false for filestore-backed attachments (the common
//          case), causing real files to be dropped by the old .filter(a=>a.datas).
app.post('/api/attachments/download', async (req, res) => {
  const s = loadSettings();
  const { moveIds = [], entries = [] } = req.body;  // entries = [{ odoo_id, entry_no }]
  if (!moveIds.length) return res.status(400).json({ ok: false, error: 'No move IDs provided' });

  const limitedIds = moveIds.slice(0, 500);  // raised: 100 → 500
  console.log(`\n📎 Attachment Download | ${limitedIds.length} entries`);

  try {
    const session = await odooAuthenticate(s.url, s.db, s.username, s.apiKey);

    // Step 1: Find attachment records — metadata only, no datas yet.
    // search_read() returns datas=false for filestore-backed files in Odoo 16+,
    // so we fetch metadata first then read datas separately.
    const attMeta = await odooCall(session, 'ir.attachment', 'search_read',
      [[['res_model', '=', 'account.move'], ['res_id', 'in', limitedIds]]],
      { fields: ['id', 'name', 'mimetype', 'res_id'], limit: 2000 }
    );

    console.log(`  📄 ${attMeta.length} attachment records found`);

    // Build entry_no lookup
    const entryMap = {};
    entries.forEach(e => { entryMap[e.odoo_id] = e.entry_no || String(e.odoo_id); });

    // Step 2: Read datas in batches of 20 using read() which always returns
    // the computed binary field correctly regardless of storage backend.
    const attachments = [];
    const DATAS_BATCH = 20;
    for (let i = 0; i < attMeta.length; i += DATAS_BATCH) {
      const batch    = attMeta.slice(i, i + DATAS_BATCH);
      const batchIds = batch.map(a => a.id);
      let dataRows;
      try {
        dataRows = await odooCall(session, 'ir.attachment', 'read',
          [batchIds],
          { fields: ['id', 'datas'] }
        );
      } catch (readErr) {
        console.warn(`  ⚠ datas read failed for batch ${i}–${i + DATAS_BATCH}: ${readErr.message}`);
        continue;
      }
      const datasMap = {};
      dataRows.forEach(d => { if (d.datas) datasMap[d.id] = d.datas; });

      batch.forEach(att => {
        const datas = datasMap[att.id];
        if (!datas) {
          // Metadata exists but binary is genuinely missing (deleted from filestore)
          console.warn(`  ⚠ No binary for attachment id=${att.id} (${att.name}) — skipping`);
          return;
        }
        attachments.push({
          move_id:  att.res_id,
          entry_no: entryMap[att.res_id] || String(att.res_id),
          filename: att.name || `attachment_${att.id}`,
          mimetype: att.mimetype || 'application/octet-stream',
          data_b64: datas
        });
      });
    }

    console.log(`  ✅ ${attachments.length} attachments fetched (${attMeta.length - attachments.length} skipped — no binary data)`);
    res.json({ ok: true, count: attachments.length, attachments });

  } catch(e) {
    console.error('❌ Attachment download error:', e.message);
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

// ── POST /api/sync/account-deviation ─────────────────────────
// Correct logic:
//   1. For each vendor, build their ESTABLISHED account set =
//      accounts that appear in >= minMonths distinct calendar months.
//   2. A vendor like RESURGENT who books Rent (12 months) + Maintenance (12 months)
//      will have BOTH in their established set → no deviation for either.
//   3. Only flag an entry whose account does NOT appear in the established set
//      → it is a genuinely new/unusual account for that vendor.
//
// Body: { dateFrom, dateTo, accountScope, minMonthsToEstablish }
//   minMonthsToEstablish (default 2): account must appear in ≥ N distinct months
//   to be considered "established" for a vendor.
app.post('/api/sync/account-deviation', async (req, res) => {
  const s = loadSettings();
  const {
    dateFrom, dateTo,
    accountScope          = 'expense',
    minMonthsToEstablish  = 2    // account must appear in ≥ 2 distinct months to be "established"
  } = req.body;
  if (!dateFrom || !dateTo)
    return res.status(400).json({ ok: false, error: 'dateFrom and dateTo required' });

  console.log('\n🔍 Account Deviation | ' + dateFrom + ' → ' + dateTo +
              ' | minMonths=' + minMonthsToEstablish);
  try {
    const session = await odooAuthenticate(s.url, s.db, s.username, s.apiKey);

    // ── Excluded account codes ────────────────────────────────────
    const EXCL = new Set(['410003','410004','410010','410013','410016','410017','410021','410022',
      '410026','410028','410031','410033','410038','410042','410044','410046','410053','410058',
      '410060','410063','410071','410072','410075','410077','410088','410095','410101','410102',
      '410103','410104','410106','410107','410108','410110','410111','130003']);

    const expenseTypes = ['expense','expense_direct_cost','expense_depreciation'];
    const incomeTypes  = ['income','income_other'];
    let accountDomain  = [['deprecated','=',false]];
    if (accountScope === 'expense')
      accountDomain.push(['account_type','in',expenseTypes]);
    else if (accountScope === 'all_pl')
      accountDomain.push(['account_type','in',[...expenseTypes,...incomeTypes]]);

    const allAccounts = await odooCall(session,'account.account','search_read',
      [accountDomain],{ fields:['id','code','name'], limit:5000 });
    const accountMap = {}; const accountIds = [];
    allAccounts.forEach(a => {
      if (!EXCL.has((a.code||'').trim())) { accountMap[a.id] = a; accountIds.push(a.id); }
    });
    if (!accountIds.length) return res.json({ ok:true, deviations:[], vendors_checked:0 });

    // ── Fetch all posted vendor bills in range ────────────────────
    const bills = await odooCall(session,'account.move','search_read',
      [[['move_type','in',['in_invoice','in_refund']],['state','=','posted'],
        ['invoice_date','>=',dateFrom],['invoice_date','<=',dateTo],
        ['partner_id','!=',false]]],
      { fields:['id','name','ref','narration','invoice_date','partner_id','amount_total'],
        limit:50000, order:'invoice_date asc',
        context:{ lang:'en_IN', allowed_company_ids:[] } });
    if (!bills.length) return res.json({ ok:true, deviations:[], vendors_checked:0 });

    const billMap = {};
    bills.forEach(b => { billMap[b.id] = b; });
    const billIds = bills.map(b => b.id);

    // ── Fetch expense account lines per bill ──────────────────────
    // linesByBill[bill_id] = [ { account_id, account_code, account_name, amount } ]
    const linesByBill = {};
    for (let i = 0; i < billIds.length; i += 2000) {
      const lines = await odooCall(session,'account.move.line','search_read',
        [[['move_id','in',billIds.slice(i,i+2000)],['account_id','in',accountIds]]],
        { fields:['move_id','account_id','debit','credit'], limit:200000 });
      lines.forEach(l => {
        const bid = l.move_id?.[0]; const aid = l.account_id?.[0]; if (!bid||!aid) return;
        if (!linesByBill[bid]) linesByBill[bid] = [];
        linesByBill[bid].push({
          account_id:   aid,
          account_code: accountMap[aid]?.code || '',
          account_name: accountMap[aid]?.name || (l.account_id?.[1]||''),
          amount:       Math.abs((l.debit||0)-(l.credit||0))
        });
      });
    }

    // ── Step 1: Build vendor → account → Set<months> map ─────────
    // For each vendor, track WHICH distinct calendar months each account appears in.
    // vendorAccountMonths[partnerId][accountId] = Set of "YYYY-MM" strings
    const vendorAccountMonths = {};
    const vendorNames = {};

    bills.forEach(b => {
      const pid   = b.partner_id?.[0]; if (!pid) return;
      const month = (b.invoice_date||'').substring(0,7); if (!month) return;
      vendorNames[pid] = b.partner_id?.[1] || 'Unknown';
      if (!linesByBill[b.id]?.length) return;

      // Consider ALL expense accounts used in this bill (not just the "primary")
      // because a single bill may legitimately split across two heads
      const accountsInBill = new Set(linesByBill[b.id].map(l => l.account_id));
      accountsInBill.forEach(aid => {
        if (!vendorAccountMonths[pid]) vendorAccountMonths[pid] = {};
        if (!vendorAccountMonths[pid][aid]) vendorAccountMonths[pid][aid] = new Set();
        vendorAccountMonths[pid][aid].add(month);
      });
    });

    // ── Step 2: Determine "established" accounts per vendor ───────
    // An account is established if it appears in >= minMonthsToEstablish distinct months.
    // RESURGENT: Rent = 12 months → established. Maintenance = 10 months → established.
    // vendorEstablished[partnerId] = Set of established accountIds
    const vendorEstablished = {};
    Object.entries(vendorAccountMonths).forEach(([pid, accMonths]) => {
      const established = new Set();
      Object.entries(accMonths).forEach(([aid, months]) => {
        if (months.size >= minMonthsToEstablish) established.add(Number(aid));
      });
      if (established.size > 0) vendorEstablished[pid] = established;
    });

    console.log('  ✅ ' + Object.keys(vendorEstablished).length + ' vendors with established accounts');

    // ── Step 3: Flag entries using NON-established accounts ───────
    // For each bill, check every expense account line.
    // If ANY account in the bill is NOT in the vendor's established set → deviation.
    // Also collect the established accounts as "context" for the UI.
    const deviations = [];

    bills.forEach(b => {
      const pid = b.partner_id?.[0]; if (!pid) return;
      const est = vendorEstablished[pid]; if (!est) return; // vendor has no established pattern yet
      if (!linesByBill[b.id]?.length) return;

      // Find all expense accounts used in this bill
      const linesInBill = linesByBill[b.id];

      // Deduplicate accounts within this bill (take max amount per account)
      const billAccMap = {};
      linesInBill.forEach(l => {
        if (!billAccMap[l.account_id] || l.amount > billAccMap[l.account_id].amount)
          billAccMap[l.account_id] = l;
      });
      const billAccounts = Object.values(billAccMap);

      // Find accounts in this bill that are NOT established for this vendor
      const deviatingLines = billAccounts.filter(l => !est.has(l.account_id));
      if (!deviatingLines.length) return; // all accounts are established → no deviation

      // Build "usual accounts" string for context
      const usualAccounts = [...est]
        .map(aid => accountMap[aid] ? `${accountMap[aid].code} - ${accountMap[aid].name}` : '')
        .filter(Boolean)
        .sort()
        .join(' | ');

      const narr = (b.narration||'')
        .replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim().substring(0,120);

      // One deviation row per deviating account line in the bill
      deviatingLines.forEach(dl => {
        const monthsUsed = vendorAccountMonths[pid]?.[dl.account_id]?.size || 0;
        deviations.push({
          odoo_id:             b.id,
          entry_no:            b.name || '',
          date:                b.invoice_date || '',
          bill_ref:            (b.ref||'').trim(),
          narration:           narr,
          partner_id:          pid,
          vendor:              vendorNames[pid] || '',
          usual_accounts:      usualAccounts,   // all established accounts for this vendor
          deviated_account_code: dl.account_code,
          deviated_account_name: dl.account_name,
          times_used:          monthsUsed,      // how many months this account has appeared (< threshold)
          amount:              Math.round(Math.abs(b.amount_total||0) * 100) / 100
        });
      });
    });

    deviations.sort((a,b) => a.vendor.localeCompare(b.vendor) || a.date.localeCompare(b.date));

    const vendorsAffected = new Set(deviations.map(d => d.partner_id)).size;
    console.log('  ✅ ' + deviations.length + ' deviations across ' + vendorsAffected + ' vendors');

    res.json({
      ok: true,
      deviations,
      total_deviations:        deviations.length,
      vendors_checked:         Object.keys(vendorEstablished).length,
      vendors_with_deviation:  vendorsAffected
    });

  } catch(e) {
    console.error('❌ Account deviation error:', e.message);
    res.status(400).json({ ok:false, error:e.message });
  }
});

// ── Data persistence: Firebase (cloud) or local file (fallback) ──
// Firebase is used when FIREBASE_DB_URL + FIREBASE_SECRET are configured.
// Otherwise data is saved to a local JSON file next to settings.json.
// Local file persists across page refreshes and server restarts;
// it is lost only when Render redeploys (a new container is created).

const LOCAL_DB_FILE = path.join(__dirname, 'local-db.json');

function localDbRead() {
  try { return JSON.parse(fs.readFileSync(LOCAL_DB_FILE, 'utf8')); }
  catch(e) { return {}; }
}
function localDbWrite(store) {
  try { fs.writeFileSync(LOCAL_DB_FILE, JSON.stringify(store, null, 2)); }
  catch(e) { console.error('localDb write error:', e.message); }
}

function fbUrl(key) {
  const s = loadSettings();
  const base   = (s.firebaseDbUrl || '').replace(/\/+$/, '');
  const secret = s.firebaseSecret || '';
  if (!base || !secret) return null;
  return { url: `${base}/auditiq/${key}.json?auth=${secret}` };
}

// GET /api/db/:key
app.get('/api/db/:key', async (req, res) => {
  const key = req.params.key;
  const fb  = fbUrl(key);
  if (fb) {
    try {
      const r = await fetch(fb.url);
      if (!r.ok) throw new Error('Firebase ' + r.status);
      const data = await r.json();
      return res.json({ ok: true, data, source: 'firebase' });
    } catch(e) {
      console.error('Firebase read error:', e.message);
      // fall through to local file
    }
  }
  // Local file fallback
  const store = localDbRead();
  res.json({ ok: true, data: store[key] ?? null, source: 'local-file' });
});

// POST /api/db/:key  (body = JSON to store)
app.post('/api/db/:key', async (req, res) => {
  const key  = req.params.key;
  const body = req.body;
  const fb   = fbUrl(key);
  if (fb) {
    try {
      const r = await fetch(fb.url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!r.ok) throw new Error('Firebase ' + r.status);
      return res.json({ ok: true, source: 'firebase' });
    } catch(e) {
      console.error('Firebase write error:', e.message);
      // fall through to local file
    }
  }
  // Local file fallback
  const store = localDbRead();
  store[key]  = body;
  localDbWrite(store);
  res.json({ ok: true, source: 'local-file' });
});

// DELETE /api/db/:key
app.delete('/api/db/:key', async (req, res) => {
  const key = req.params.key;
  const fb  = fbUrl(key);
  if (fb) {
    try {
      const r = await fetch(fb.url, { method: 'DELETE' });
      if (!r.ok) throw new Error('Firebase ' + r.status);
      return res.json({ ok: true, source: 'firebase' });
    } catch(e) { /* fall through */ }
  }
  const store = localDbRead();
  delete store[key];
  localDbWrite(store);
  res.json({ ok: true, source: 'local-file' });
});

// GET /api/db-status  — tells the client if Firebase is configured
app.get('/api/db-status', (req, res) => {
  const s = loadSettings();
  const configured = !!(s.firebaseDbUrl && s.firebaseSecret);
  res.json({ ok: true, configured, source: configured ? 'firebase' : 'none' });
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


// ══════════════════════════════════════════════════════════════
// DUPLICATE INVOICE DETECTION
// ══════════════════════════════════════════════════════════════
// Finds vendor bills with same (partner_id + ref) posted more than once.
// Also flags same amount + same vendor within 7 days as suspicious.
app.post('/api/sync/duplicate-invoices', async (req, res) => {
  const s = loadSettings();
  const { dateFrom, dateTo } = req.body;
  if (!dateFrom || !dateTo) return res.status(400).json({ ok:false, error:'dateFrom and dateTo required' });

  console.log('\n🔍 Duplicate Invoice Check | ' + dateFrom + ' → ' + dateTo);
  try {
    const session = await odooAuthenticate(s.url, s.db, s.username, s.apiKey);

    const bills = await odooCall(session, 'account.move', 'search_read',
      [[['move_type','in',['in_invoice','in_refund']],['state','=','posted'],
        ['invoice_date','>=',dateFrom],['invoice_date','<=',dateTo],
        ['partner_id','!=',false]]],
      { fields:['id','name','ref','invoice_date','partner_id','amount_total','journal_id'],
        limit:50000, order:'invoice_date asc',
        context:{ lang:'en_IN', allowed_company_ids:[] } }
    );

    const duplicates = [];

    // ── Type A: Same vendor + same Bill Reference ─────────────────
    const refMap = {}; // "pid|ref" → [bills]
    bills.forEach(b => {
      const ref = (b.ref || '').trim().toLowerCase();
      if (!ref || ref === '/' || ref === '') return; // skip blank refs
      const key = `${b.partner_id?.[0]}|${ref}`;
      if (!refMap[key]) refMap[key] = [];
      refMap[key].push(b);
    });

    Object.entries(refMap).forEach(([key, group]) => {
      if (group.length < 2) return;
      group.forEach((b, i) => {
        duplicates.push({
          type:        'Same Bill Reference',
          duplicate_of: group.filter((_,j) => j !== i).map(x => x.name).join(', '),
          odoo_id:     b.id,
          entry_no:    b.name || '',
          date:        b.invoice_date || '',
          vendor:      b.partner_id?.[1] || '',
          partner_id:  b.partner_id?.[0],
          bill_ref:    b.ref || '',
          amount:      Math.round(Math.abs(b.amount_total||0)*100)/100,
          journal:     b.journal_id?.[1] || '',
          severity:    'high'
        });
      });
    });

    // ── Type B: Same vendor + same amount within 7 days ──────────
    // Group by vendor, sort by date, check consecutive pairs
    const byVendor = {};
    bills.forEach(b => {
      const pid = b.partner_id?.[0]; if (!pid) return;
      if (!byVendor[pid]) byVendor[pid] = [];
      byVendor[pid].push(b);
    });

    Object.values(byVendor).forEach(vBills => {
      vBills.sort((a,b) => a.invoice_date.localeCompare(b.invoice_date));
      for (let i = 0; i < vBills.length; i++) {
        for (let j = i+1; j < vBills.length; j++) {
          const a = vBills[i], b = vBills[j];
          const daysDiff = (new Date(b.invoice_date) - new Date(a.invoice_date)) / 86400000;
          if (daysDiff > 7) break;
          const amtA = Math.abs(a.amount_total||0);
          const amtB = Math.abs(b.amount_total||0);
          if (Math.abs(amtA - amtB) < 1) { // same amount ± ₹1
            const refA = (a.ref||'').trim(), refB = (b.ref||'').trim();
            if (refA && refB && refA.toLowerCase() === refB.toLowerCase()) continue; // already caught above
            // Only add if not already flagged
            const alreadyFlagged = duplicates.some(d => d.odoo_id === a.id || d.odoo_id === b.id);
            if (!alreadyFlagged) {
              [a, b].forEach(bill => {
                duplicates.push({
                  type:        'Same Amount (7-day window)',
                  duplicate_of: [a,b].filter(x => x.id !== bill.id).map(x => x.name).join(', '),
                  odoo_id:     bill.id,
                  entry_no:    bill.name || '',
                  date:        bill.invoice_date || '',
                  vendor:      bill.partner_id?.[1] || '',
                  partner_id:  bill.partner_id?.[0],
                  bill_ref:    bill.ref || '',
                  amount:      Math.round(Math.abs(bill.amount_total||0)*100)/100,
                  journal:     bill.journal_id?.[1] || '',
                  severity:    'medium'
                });
              });
            }
          }
        }
      }
    });

    duplicates.sort((a,b) => a.vendor.localeCompare(b.vendor) || a.date.localeCompare(b.date));
    console.log('  ✅ ' + duplicates.length + ' potential duplicates found');
    res.json({ ok:true, duplicates, total: duplicates.length,
      high: duplicates.filter(d=>d.severity==='high').length,
      medium: duplicates.filter(d=>d.severity==='medium').length });
  } catch(e) {
    console.error('❌ Duplicate check error:', e.message);
    res.status(400).json({ ok:false, error:e.message });
  }
});

// ══════════════════════════════════════════════════════════════
// BACKDATED ENTRY DETECTION
// ══════════════════════════════════════════════════════════════
// Flags entries where invoice_date is in a prior month but
// create_date (actual entry date) is significantly later.
app.post('/api/sync/backdated-entries', async (req, res) => {
  const s = loadSettings();
  const { dateFrom, dateTo, lagDays = 15 } = req.body;
  if (!dateFrom || !dateTo) return res.status(400).json({ ok:false, error:'dateFrom and dateTo required' });

  console.log('\n📅 Backdated Entry Check | ' + dateFrom + ' → ' + dateTo + ' | lag>' + lagDays + 'd');
  try {
    const session = await odooAuthenticate(s.url, s.db, s.username, s.apiKey);

    const bills = await odooCall(session, 'account.move', 'search_read',
      [[['move_type','in',['in_invoice','in_refund','entry']],['state','=','posted'],
        ['invoice_date','>=',dateFrom],['invoice_date','<=',dateTo],
        ['partner_id','!=',false]]],
      { fields:['id','name','ref','invoice_date','create_date','write_date','partner_id','amount_total','journal_id','move_type','narration'],
        limit:50000, order:'invoice_date asc',
        context:{ lang:'en_IN', allowed_company_ids:[] } }
    );

    const backdated = [];
    bills.forEach(b => {
      const invoiceDate = new Date(b.invoice_date);
      const createDate  = new Date((b.create_date||'').split(' ')[0]); // strip time
      if (isNaN(invoiceDate) || isNaN(createDate)) return;

      const lagDaysActual = Math.round((createDate - invoiceDate) / 86400000);
      if (lagDaysActual < lagDays) return; // within acceptable range

      // Check if it crosses a month boundary (more serious)
      const crossesMonth = invoiceDate.getMonth() !== createDate.getMonth() ||
                           invoiceDate.getFullYear() !== createDate.getFullYear();

      const narr = (b.narration||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim().substring(0,100);
      const typeLabel = { entry:'Journal Entry', in_invoice:'Vendor Bill',
        in_refund:'Vendor Credit', out_invoice:'Customer Invoice' }[b.move_type] || b.move_type;

      backdated.push({
        odoo_id:       b.id,
        entry_no:      b.name || '',
        invoice_date:  b.invoice_date || '',
        create_date:   (b.create_date||'').split(' ')[0],
        lag_days:      lagDaysActual,
        crosses_month: crossesMonth,
        severity:      crossesMonth ? 'high' : 'medium',
        vendor:        b.partner_id?.[1] || '',
        partner_id:    b.partner_id?.[0],
        bill_ref:      (b.ref||'').trim(),
        narration:     narr,
        amount:        Math.round(Math.abs(b.amount_total||0)*100)/100,
        journal:       b.journal_id?.[1] || '',
        type_label:    typeLabel
      });
    });

    backdated.sort((a,b) => b.lag_days - a.lag_days);
    console.log('  ✅ ' + backdated.length + ' backdated entries found');
    res.json({ ok:true, backdated, total:backdated.length,
      cross_month: backdated.filter(d=>d.crosses_month).length,
      same_month:  backdated.filter(d=>!d.crosses_month).length });
  } catch(e) {
    console.error('❌ Backdated check error:', e.message);
    res.status(400).json({ ok:false, error:e.message });
  }
});


// ══════════════════════════════════════════════════════════════
// WEEKEND & HOLIDAY ENTRIES MODULE
// ══════════════════════════════════════════════════════════════

// Indian public holidays (fixed + major variable ones)
const INDIA_HOLIDAYS = {
  '2024-01-26':'Republic Day','2024-03-25':'Holi','2024-03-29':'Good Friday',
  '2024-04-14':'Ambedkar Jayanti','2024-04-17':'Ram Navami','2024-04-21':'Mahavir Jayanti',
  '2024-05-23':'Buddha Purnima','2024-06-17':'Eid ul-Adha','2024-07-17':'Muharram',
  '2024-08-15':'Independence Day','2024-08-26':'Janmashtami','2024-10-02':'Gandhi Jayanti',
  '2024-10-12':'Dussehra','2024-11-01':'Diwali','2024-11-15':'Guru Nanak Jayanti',
  '2024-12-25':'Christmas',
  '2025-01-26':'Republic Day','2025-03-14':'Holi','2025-04-10':'Ram Navami',
  '2025-04-14':'Ambedkar Jayanti','2025-04-18':'Good Friday','2025-05-12':'Buddha Purnima',
  '2025-06-07':'Eid ul-Adha','2025-07-06':'Muharram','2025-08-15':'Independence Day',
  '2025-08-16':'Janmashtami','2025-10-02':'Gandhi Jayanti','2025-10-20':'Diwali',
  '2025-11-05':'Guru Nanak Jayanti','2025-12-25':'Christmas',
  '2026-01-26':'Republic Day','2026-03-04':'Maha Shivratri','2026-03-20':'Holi',
  '2026-03-30':'Ram Navami','2026-04-02':'Good Friday','2026-04-14':'Ambedkar Jayanti',
  '2026-04-19':'Mahavir Jayanti','2026-05-31':'Buddha Purnima',
  '2026-08-15':'Independence Day','2026-09-04':'Janmashtami',
  '2026-10-02':'Gandhi Jayanti','2026-11-08':'Diwali','2026-12-25':'Christmas'
};

function getEntryDayInfo(dateStr) {
  if (!dateStr) return null;
  const d   = new Date(dateStr);
  const dow = d.getDay(); // 0=Sun, 6=Sat
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const holiday  = INDIA_HOLIDAYS[dateStr] || null;
  const weekend  = dow === 0 || dow === 6;
  if (!weekend && !holiday) return null;
  return { day_name: dayNames[dow], is_weekend: weekend, is_holiday: !!holiday, holiday_name: holiday };
}

// POST /api/sync/weekend-holiday-entries
// Fetches all posted journal entries in range, returns only those on weekends or holidays.
app.post('/api/sync/weekend-holiday-entries', async (req, res) => {
  const s = loadSettings();
  const { dateFrom, dateTo, entryTypes = ['in_invoice','in_refund','entry'] } = req.body;
  if (!dateFrom || !dateTo) return res.status(400).json({ ok:false, error:'dateFrom and dateTo required' });

  console.log('\n📅 Weekend/Holiday Entries | ' + dateFrom + ' → ' + dateTo);
  try {
    const session = await odooAuthenticate(s.url, s.db, s.username, s.apiKey);

    // Fetch all posted entries in range
    const typeDomain = entryTypes.length
      ? [['move_type','in', entryTypes]]
      : [['move_type','in',['in_invoice','in_refund','entry','out_invoice','out_refund']]];

    const moves = await odooCall(session, 'account.move', 'search_read',
      [[...typeDomain, ['state','=','posted'],
        ['date','>=',dateFrom], ['date','<=',dateTo]]],
      { fields:['id','name','date','ref','narration','partner_id','journal_id','move_type','amount_total'],
        limit:50000, order:'date asc',
        context:{ lang:'en_IN', allowed_company_ids:[] } }
    );

    const results = [];
    moves.forEach(m => {
      const dayInfo = getEntryDayInfo(m.date);
      if (!dayInfo) return; // normal working day — skip

      const narr = (m.narration||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim().substring(0,120);
      const typeLabel = {
        entry:'Journal Entry', in_invoice:'Vendor Bill', in_refund:'Vendor Credit',
        out_invoice:'Customer Invoice', out_refund:'Customer Credit'
      }[m.move_type] || m.move_type;

      results.push({
        odoo_id:      m.id,
        entry_no:     m.name || '',
        date:         m.date || '',
        day_name:     dayInfo.day_name,
        is_weekend:   dayInfo.is_weekend,
        is_holiday:   dayInfo.is_holiday,
        holiday_name: dayInfo.holiday_name || '',
        flag_type:    dayInfo.is_holiday ? 'Holiday' : 'Weekend',
        type_label:   typeLabel,
        partner:      m.partner_id?.[1] || '',
        journal:      m.journal_id?.[1] || '',
        bill_ref:     (m.ref||'').trim(),
        narration:    narr,
        amount:       Math.round(Math.abs(m.amount_total||0)*100)/100
      });
    });

    results.sort((a,b) => a.date.localeCompare(b.date));

    const weekendCount = results.filter(r => r.is_weekend && !r.is_holiday).length;
    const holidayCount = results.filter(r => r.is_holiday).length;

    console.log(`  ✅ ${results.length} entries on weekends/holidays (${weekendCount} weekend, ${holidayCount} holiday)`);
    res.json({
      ok: true,
      entries: results,
      total:   results.length,
      weekend: weekendCount,
      holiday: holidayCount
    });
  } catch(e) {
    console.error('❌ Weekend/holiday check error:', e.message);
    res.status(400).json({ ok:false, error:e.message });
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
  console.log(`║  Odoo Books Audit     v2.0  →  port ${PORT}          ║`);
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

// ══════════════════════════════════════════════════════════════
// TDS COMPLIANCE MODULE
// ══════════════════════════════════════════════════════════════

// ── TDS Section rules ─────────────────────────────────────────
const TDS_SECTIONS = {
  '194C': {
    name: 'Payment to Contractors',
    rate_individual: 1, rate_company: 2,
    single_limit: 30000, annual_limit: 100000,
    keywords: ['contract','labour','manpower','work','fabricat','construct','transport','cargo','logistic','courier','freight','dispatch','housekeep','security','guard','maintenance','facility','civil','architect','interior','printing','advertis','catering','event','exhibit']
  },
  '194H': {
    name: 'Commission or Brokerage',
    rate_individual: 5, rate_company: 5,
    single_limit: 20000, annual_limit: 20000,
    keywords: ['commission','brokerage','broker','agent','referral','introduc']
  },
  '194I': {
    name: 'Rent',
    rate_individual: 10, rate_company: 10,
    single_limit: 50000, annual_limit: 240000,
    keywords: ['rent','lease','hire','coworking','co-working','office space','warehouse','storage']
  },
  '194J': {
    name: 'Professional / Technical Services',
    rate_individual: 10, rate_company: 10,
    single_limit: 50000, annual_limit: 50000,
    keywords: ['professional','consultant','advisory','legal','audit','accountan','chartered','lawyer','advocate','technical','software','saas','cloud','hosting','licence','license','subscription','training','coaching','expert','valuation','architect','design','it service','technology','develop','engineer']
  },
  '194A': {
    name: 'Interest (other than securities)',
    rate_individual: 10, rate_company: 10,
    single_limit: 40000, annual_limit: 40000,
    keywords: ['interest','loan interest','finance charge','delayed payment']
  }
};

// Auto-map account name → TDS section using keyword matching
function inferTDSSection(accountName, accountCode) {
  const text = (accountName + ' ' + accountCode).toLowerCase();
  for (const [section, cfg] of Object.entries(TDS_SECTIONS)) {
    if (cfg.keywords.some(kw => text.includes(kw))) return section;
  }
  return null;
}

// ── GET /api/tds/sections — return TDS section rules ─────────
app.get('/api/tds/sections', (req, res) => {
  res.json({ ok: true, sections: TDS_SECTIONS });
});

// ── POST /api/tds/map-accounts ───────────────────────────────
// Fetches all expense accounts and auto-maps them to TDS sections.
// Returns suggested mapping for user to review/override.
app.post('/api/tds/map-accounts', async (req, res) => {
  const s = loadSettings();
  const { overrides = {} } = req.body; // { "accountCode": "194J" } user overrides
  try {
    const session = await odooAuthenticate(s.url, s.db, s.username, s.apiKey);
    const expenseTypes = ['expense','expense_direct_cost','expense_depreciation'];
    const accounts = await odooCall(session, 'account.account', 'search_read',
      [[['account_type','in',expenseTypes],['deprecated','=',false]]],
      { fields: ['id','code','name'], limit: 2000, order: 'code asc' }
    );

    const mapped = accounts.map(a => {
      const code    = (a.code||'').trim();
      const inferred = overrides[code] || inferTDSSection(a.name, code);
      return {
        id:       a.id,
        code,
        name:     a.name,
        section:  inferred || null,
        auto:     !overrides[code] && !!inferred,
        override: !!overrides[code]
      };
    });

    const withSection    = mapped.filter(a => a.section);
    const withoutSection = mapped.filter(a => !a.section);
    console.log(`✅ TDS map: ${withSection.length} accounts mapped, ${withoutSection.length} unmapped`);
    res.json({ ok: true, accounts: mapped, mapped_count: withSection.length, unmapped_count: withoutSection.length });
  } catch(e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── POST /api/tds/check ──────────────────────────────────────
// Main TDS compliance check.
// Body: { dateFrom, dateTo, accountMapping: { "410065": "194J", ... }, tdsAccounts: ["21001","21002"] }
app.post('/api/tds/check', async (req, res) => {
  const s = loadSettings();
  const { dateFrom, dateTo, accountMapping = {}, tdsAccounts = [] } = req.body;
  if (!dateFrom || !dateTo) return res.status(400).json({ ok:false, error:'dateFrom and dateTo required' });
  if (!Object.keys(accountMapping).length) return res.status(400).json({ ok:false, error:'accountMapping is required — run /api/tds/map-accounts first' });

  console.log(`\n📋 TDS Check | ${dateFrom} → ${dateTo}`);
  try {
    const session = await odooAuthenticate(s.url, s.db, s.username, s.apiKey);

    // ── Step 1: Resolve account IDs for mapped expense accounts ──
    const mappedCodes = Object.keys(accountMapping);
    const allAccounts = await odooCall(session,'account.account','search_read',
      [[['deprecated','=',false]]],
      { fields:['id','code','name','account_type'], limit:5000 }
    );

    const codeToAccount = {};
    allAccounts.forEach(a => { codeToAccount[(a.code||'').trim()] = a; });

    // Build accountId → section map
    const accountIdToSection = {};
    const accountIdToCode    = {};
    mappedCodes.forEach(code => {
      const acc = codeToAccount[code];
      if (acc) {
        accountIdToSection[acc.id] = accountMapping[code];
        accountIdToCode[acc.id]    = code;
      }
    });

    // TDS payable account IDs — auto-detect if not provided
    let tdsAccountIds = [];
    if (tdsAccounts.length) {
      tdsAccounts.forEach(code => {
        const acc = codeToAccount[code];
        if (acc) tdsAccountIds.push(acc.id);
      });
    } else {
      // Auto-detect: accounts with "TDS" or "Tax Deducted" in name
      tdsAccountIds = allAccounts
        .filter(a => /tds|tax deducted/i.test(a.name))
        .map(a => a.id);
      console.log(`  Auto-detected ${tdsAccountIds.length} TDS accounts:`, tdsAccountIds);
    }

    const expenseAccountIds = Object.keys(accountIdToSection).map(Number);
    if (!expenseAccountIds.length) return res.json({ ok:true, violations:[], summary:{} });

    // ── Step 2: Fetch all posted vendor bills in date range ───────
    const bills = await odooCall(session,'account.move','search_read',
      [[['move_type','in',['in_invoice','in_refund']],['state','=','posted'],
        ['invoice_date','>=',dateFrom],['invoice_date','<=',dateTo],
        ['partner_id','!=',false]]],
      { fields:['id','name','ref','invoice_date','partner_id','amount_total','move_type'],
        limit:50000, order:'invoice_date asc',
        context:{ lang:'en_IN', allowed_company_ids:[] } }
    );
    if (!bills.length) return res.json({ ok:true, violations:[], vendors_checked:0, summary:{} });

    const billIds  = bills.map(b => b.id);
    const billMap  = {};
    bills.forEach(b => { billMap[b.id] = b; });

    // ── Step 2b: Fetch partner type (Individual vs Company) from res.partner ──
    // company_type is on res.partner, NOT on account.move
    const partnerIds = [...new Set(bills.map(b => b.partner_id?.[0]).filter(Boolean))];
    const partnerTypeMap = {}; // partnerId → 'person' | 'company'
    for (let i = 0; i < partnerIds.length; i += 1000) {
      const partners = await odooCall(session, 'res.partner', 'search_read',
        [[['id','in',partnerIds.slice(i,i+1000)]]],
        { fields:['id','company_type'], limit:2000 }
      );
      partners.forEach(p => { partnerTypeMap[p.id] = p.company_type || 'company'; });
    }

    // ── Step 3: Fetch all move lines for these bills ──────────────
    const allLines = [];
    for (let i = 0; i < billIds.length; i += 2000) {
      const lines = await odooCall(session,'account.move.line','search_read',
        [[['move_id','in',billIds.slice(i,i+2000)]]],
        { fields:['move_id','account_id','debit','credit','partner_id'], limit:200000 }
      );
      allLines.push(...lines);
    }

    // ── Step 4: Per bill → expense sections used + TDS found ──────
    const billExpense = {}; // bill_id → { sectionCode → amount }
    const billHasTDS  = {}; // bill_id → total TDS amount deducted
    const billTDSAccounts = {}; // bill_id → [tds account names]

    allLines.forEach(l => {
      const bid = l.move_id?.[0];
      const aid = l.account_id?.[0];
      if (!bid || !aid) return;

      const section = accountIdToSection[aid];
      if (section) {
        // Expense line
        const amt = Math.abs((l.debit||0) - (l.credit||0));
        if (!billExpense[bid]) billExpense[bid] = {};
        billExpense[bid][section] = (billExpense[bid][section] || 0) + amt;
      }

      if (tdsAccountIds.includes(aid)) {
        // TDS line (credit entry on TDS payable)
        const tdsAmt = Math.abs((l.debit||0) - (l.credit||0));
        billHasTDS[bid]  = (billHasTDS[bid] || 0) + tdsAmt;
        if (!billTDSAccounts[bid]) billTDSAccounts[bid] = [];
        const accName = l.account_id?.[1] || String(aid);
        if (!billTDSAccounts[bid].includes(accName)) billTDSAccounts[bid].push(accName);
      }
    });

    // ── Step 5: Consolidate per vendor per section ───────────────
    // ONE row per vendor per section for the full FY:
    //   total_taxable  = sum of all bill amounts hitting that expense account
    //   total_tds      = sum of ALL TDS deducted across ALL bills for that vendor
    //                    (TDS on a vendor is usually in the same JE regardless of which bill)
    const vendorAnnual = {};
    const vendorNames  = {};
    const vendorType   = {};

    bills.forEach(b => {
      const pid = b.partner_id?.[0]; if (!pid) return;
      vendorNames[pid] = b.partner_id?.[1] || 'Unknown';
      vendorType[pid]  = partnerTypeMap[pid] || 'company';
      if (!billExpense[b.id]) return;

      Object.entries(billExpense[b.id]).forEach(([section, taxableAmt]) => {
        if (!vendorAnnual[pid]) vendorAnnual[pid] = {};
        if (!vendorAnnual[pid][section]) {
          vendorAnnual[pid][section] = {
            total_taxable: 0,   // sum of taxable values from expense lines
            total_tds:     0,   // sum of TDS actually deducted across all bills
            bill_count:    0,
            bills:         []   // for drill-down reference
          };
        }
        vendorAnnual[pid][section].total_taxable += taxableAmt;
        vendorAnnual[pid][section].bill_count++;
        vendorAnnual[pid][section].bills.push({
          odoo_id:  b.id,
          entry_no: b.name || '',
          date:     b.invoice_date || '',
          amount:   Math.round(taxableAmt * 100) / 100,
          tds:      Math.round((billHasTDS[b.id] || 0) * 100) / 100
        });
      });

      // Accumulate TDS deducted against this vendor (for their primary section)
      // We credit TDS to the section with the highest taxable value for this vendor
      if (billHasTDS[b.id] && billExpense[b.id]) {
        // Find the dominant section for this bill
        const entries = Object.entries(billExpense[b.id]);
        const domSection = entries.reduce((a,b) => b[1]>a[1] ? b : a, entries[0])?.[0];
        if (domSection && vendorAnnual[pid]?.[domSection]) {
          vendorAnnual[pid][domSection].total_tds += billHasTDS[b.id];
        }
      }
    });

    // ── Step 6: Consolidated violations — ONE row per vendor per section ──
    // Logic:
    //   If total_taxable > threshold → TDS was applicable for the full year
    //   Expected TDS = total_taxable × rate
    //   Actual TDS   = total_tds deducted across all bills
    //   Gap          = Expected − Actual  (positive = shortfall)
    const violations = [];

    Object.entries(vendorAnnual).forEach(([pid, sections]) => {
      Object.entries(sections).forEach(([section, data]) => {
        const cfg = TDS_SECTIONS[section];
        if (!cfg) return;

        const taxable      = Math.round(data.total_taxable * 100) / 100;
        const actualTDS    = Math.round(data.total_tds     * 100) / 100;
        const isIndividual = vendorType[pid] === 'person';
        const rate         = isIndividual ? cfg.rate_individual : cfg.rate_company;

        // TDS applicable only if total taxable crosses the annual threshold
        if (taxable <= cfg.annual_limit) return;  // below threshold — no TDS required

        const expectedTDS = Math.round(taxable * rate / 100 * 100) / 100;
        const gap         = Math.round((expectedTDS - actualTDS) * 100) / 100;

        // Show all vendors where threshold crossed — gap = 0 means fully compliant
        violations.push({
          vendor:        vendorNames[pid] || '',
          partner_id:    Number(pid),
          section,
          section_name:  cfg.name,
          rate,
          bill_count:    data.bill_count,
          total_taxable: taxable,
          annual_limit:  cfg.annual_limit,
          expected_tds:  expectedTDS,
          actual_tds:    actualTDS,
          tds_gap:       Math.max(0, gap),   // 0 if fully or over-deducted
          status:        gap <= 0 ? 'Compliant'
                       : actualTDS === 0 ? 'No TDS Deducted'
                       : 'Short Deduction',
          excess_tds:    gap < 0 ? Math.abs(gap) : 0,   // over-deducted (excess)
          // Bill-level drill-down (first 10)
          sample_bills:  data.bills.slice(0, 10)
        });
      });
    });

    // Sort: non-compliant first, then by gap descending
    violations.sort((a,b) => {
      const statusOrder = { 'No TDS Deducted':0, 'Short Deduction':1, 'Compliant':2 };
      const so = (statusOrder[a.status]||0) - (statusOrder[b.status]||0);
      return so !== 0 ? so : b.tds_gap - a.tds_gap;
    });

    // ── Summary ───────────────────────────────────────────────────
    const summary = {};
    Object.keys(TDS_SECTIONS).forEach(sec => {
      const rows = violations.filter(v => v.section === sec);
      summary[sec] = {
        vendors_above_threshold: rows.length,
        vendors_non_compliant:   rows.filter(v => v.status !== 'Compliant').length,
        total_taxable:           Math.round(rows.reduce((s,v)=>s+v.total_taxable,0)*100)/100,
        total_tds_gap:           Math.round(rows.reduce((s,v)=>s+v.tds_gap,0)*100)/100
      };
    });

    const nonCompliant = violations.filter(v => v.status !== 'Compliant');
    const totalGap     = Math.round(nonCompliant.reduce((s,v)=>s+v.tds_gap,0)*100)/100;
    console.log(`✅ ${violations.length} vendors above threshold | ${nonCompliant.length} non-compliant | Gap ₹${totalGap}`);
    res.json({
      ok: true,
      violations,                                         // all rows (compliant + non-compliant)
      total_above_threshold: violations.length,
      total_non_compliant:   nonCompliant.length,
      vendors_affected:      new Set(nonCompliant.map(v=>v.partner_id)).size,
      total_tds_gap:         totalGap,
      vendors_checked:       Object.keys(vendorAnnual).length,
      tds_accounts_used:     tdsAccountIds.length,
      summary
    });

  } catch(e) {
    console.error('❌ TDS check error:', e.message);
    res.status(400).json({ ok:false, error:e.message });
  }
});


// ── POST /api/partners/search ──────────────────────────────────
// Search Odoo vendors by name — used for autocomplete in the
// Recurring Invoices "Add Vendor" form.
// Body: { query: "AWS" }
app.post('/api/partners/search', async (req, res) => {
  const s = loadSettings();
  const { query = '' } = req.body;
  if (!query || query.trim().length < 2)
    return res.json({ ok:true, partners:[] });

  try {
    const session = await odooAuthenticate(s.url, s.db, s.username, s.apiKey);
    const partners = await odooCall(session, 'res.partner', 'search_read',
      [[['name','ilike', query.trim()], ['active','=',true]]],
      { fields:['id','name'], limit:15, order:'name asc' }
    );
    res.json({ ok:true, partners: partners.map(p => ({ id:p.id, name:p.name })) });
  } catch(e) {
    console.error('❌ Partner search error:', e.message);
    res.status(400).json({ ok:false, error:e.message });
  }
});


// ── POST /api/recurring/check ──────────────────────────────────
// Given a list of Odoo partner_ids and a check month (YYYY-MM),
// returns which partners have posted vendor bills that month and
// which are missing.
// Body: { checkYearMonth: "2026-04", partner_ids: [123, 456, ...] }
app.post('/api/recurring/check', async (req, res) => {
  const s = loadSettings();
  const { checkYearMonth, partner_ids = [] } = req.body;

  if (!partner_ids.length)
    return res.json({ ok:true, results:[], check_month: checkYearMonth });

  // Derive date range for the check month
  const checkDate  = new Date(checkYearMonth + '-01');
  const dateFrom   = checkYearMonth + '-01';
  const lastDay    = new Date(checkDate.getFullYear(), checkDate.getMonth() + 1, 0);
  const dateTo     = lastDay.toISOString().slice(0, 10);

  console.log(`\n🔄 Recurring check | month: ${checkYearMonth} | vendors: ${partner_ids.length}`);

  try {
    const session = await odooAuthenticate(s.url, s.db, s.username, s.apiKey);

    // Fetch all posted vendor bills for this month for the given partners
    const bills = await odooCall(session, 'account.move', 'search_read',
      [[
        ['move_type', 'in', ['in_invoice']],
        ['state', '=', 'posted'],
        ['invoice_date', '>=', dateFrom],
        ['invoice_date', '<=', dateTo],
        ['partner_id', 'in', partner_ids]
      ]],
      { fields: ['id', 'name', 'invoice_date', 'partner_id', 'amount_total'], limit: 10000 }
    );

    // Group by partner_id
    const found = {}; // partner_id → { count, total_amt }
    bills.forEach(b => {
      const pid = b.partner_id?.[0]; if (!pid) return;
      if (!found[pid]) found[pid] = { count: 0, amount: 0 };
      found[pid].count++;
      found[pid].amount += b.amount_total || 0;
    });

    const results = partner_ids.map(pid => ({
      partner_id:  pid,
      status:      found[pid] ? 'Booked ✓' : 'Missing ⚠',
      found_count: found[pid]?.count  || 0,
      found_amt:   found[pid]?.amount || 0
    }));

    const missing = results.filter(r => r.status === 'Missing ⚠').length;
    console.log(`✅ ${results.length} checked | ${missing} missing | ${results.length - missing} booked`);

    res.json({
      ok:          true,
      check_month: checkYearMonth,
      date_range:  `${dateFrom} → ${dateTo}`,
      results,
      total:       results.length,
      missing,
      booked:      results.length - missing
    });

  } catch(e) {
    console.error('❌ Recurring check error:', e.message);
    res.status(400).json({ ok:false, error:e.message });
  }
});


// ── POST /api/vendor/bills-for-month ──────────────────────────
// Returns individual bills for a vendor in a specific month.
// Used by the Monthly Ledger popup to show invoice numbers.
// Body: { partner_id: 123, year_month: "2026-04" }
app.post('/api/vendor/bills-for-month', async (req, res) => {
  const s = loadSettings();
  const { partner_id, year_month } = req.body;
  if (!partner_id || !year_month)
    return res.json({ ok: true, bills: [] });

  const dateFrom = year_month + '-01';
  const lastDay  = new Date(year_month.split('-')[0], year_month.split('-')[1], 0);
  const dateTo   = lastDay.toISOString().slice(0, 10);

  try {
    const session = await odooAuthenticate(s.url, s.db, s.username, s.apiKey);
    const bills = await odooCall(session, 'account.move', 'search_read',
      [[
        ['move_type', 'in', ['in_invoice', 'in_refund']],
        ['state', '=', 'posted'],
        ['invoice_date', '>=', dateFrom],
        ['invoice_date', '<=', dateTo],
        ['partner_id', '=', partner_id]
      ]],
      { fields: ['id', 'name', 'ref', 'invoice_date', 'amount_total'], limit: 50, order: 'invoice_date asc' }
    );
    res.json({
      ok: true,
      bills: bills.map(b => ({
        id:     b.id,
        name:   b.name,
        ref:    b.ref || '',
        date:   b.invoice_date,
        amount: b.amount_total
      }))
    });
  } catch(e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});
