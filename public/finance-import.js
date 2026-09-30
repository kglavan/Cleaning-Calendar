// Turns a Stessa "Export CSV" into fin_transactions rows. Shared by the
// Finance page (Import tab) and finance/import-stessa.js so both apply the
// same rules. Plain script (no import/export) so the browser can load it
// with a <script> tag; Node imports it for its side effect and reads
// globalThis.FinanceImport.
(function () {
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((f) => f.trim() !== ''));
  }

  // Header names are matched loosely (case, spaces, punctuation and a
  // leading byte-order mark are ignored).
  const norm = (h) => h.toLowerCase().replace(/[^a-z]/g, '');
  const COLUMNS = {
    date: ['date', 'transactiondate', 'posteddate'],
    description: ['name', 'description', 'payee', 'merchant'],
    amount: ['amount'],
    category: ['category', 'parentcategory', 'topcategory'],
    sub_category: ['subcategory', 'subcat'],
    property: ['property', 'propertyname'],
    institution: ['datasource', 'bank', 'institution'],
    account: ['account', 'accountname', 'bankaccount'],
    notes: ['notes', 'note', 'memo'],
  };

  function parseAmount(s) {
    const t = String(s || '').trim();
    if (!t) return null;
    const negative = /^\(.*\)$/.test(t) || t.startsWith('-') || t.startsWith('$-');
    const n = Number(t.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? (negative ? -n : n) : null;
  }

  function parseDate(s) {
    const t = String(s || '').trim();
    let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) {
      const y = m[3].length === 2 ? `20${m[3]}` : m[3];
      return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    }
    return null;
  }

  // Drop bank reference numbers (ACH/PPD/CCD/WEB IDs, long digit runs and
  // long letter+digit reference codes) before anything is stored.
  function sanitize(text) {
    return String(text || '')
      .replace(/\b(PPD|CCD|WEB|TEL|ACH)\s*ID:?\s*\S+/gi, '')
      .replace(/\b[A-Z0-9]*\d{6,}[A-Z0-9]*\b/gi, '')
      .replace(/\b[A-Z]{1,3}-(?=[A-Z0-9]*\d[A-Z0-9]*\d)[A-Z0-9]{6,}\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  // Categories we always know better than a (possibly mis-set) Stessa
  // category, matched on the raw bank description.
  const CATEGORY_RULES = [
    // Every mortgage payment is to Pennymac; one was once filed as a Transfer.
    { test: /pennymac/i, category: 'Mortgages & Loans', sub_category: 'Mortgage Payment' },
  ];

  function applyRules(raw, category, subCategory) {
    const rule = CATEGORY_RULES.find((r) => r.test.test(raw));
    return rule ? { category: rule.category, sub_category: rule.sub_category } : { category, sub_category: subCategory };
  }

  function platformOf(desc, category) {
    if (category !== 'Income') return null;
    if (/airbnb/i.test(desc)) return 'airbnb';
    if (/vrbo|homeaway|expedia/i.test(desc)) return 'vrbo';
    if (/booking\.com/i.test(desc)) return 'booking';
    if (/venmo|zelle|direct/i.test(desc)) return 'direct';
    return null;
  }

  // text: the CSV file's contents. hash: async (string) => hex id.
  // Returns { rows, skipped, missing, header }.
  async function prepare(text, hash) {
    const [header, ...body] = parseCsv(text);
    if (!header) return { rows: [], skipped: [], missing: ['date', 'description', 'amount'], header: [] };
    const idx = {};
    const normalized = header.map(norm);
    Object.entries(COLUMNS).forEach(([key, names]) => {
      for (const n of names) {
        const i = normalized.indexOf(n);
        if (i >= 0) { idx[key] = i; break; }
      }
    });
    const missing = ['date', 'description', 'amount'].filter((k) => idx[k] === undefined);
    if (missing.length) return { rows: [], skipped: [], missing, header };

    const seen = {};
    const rows = [];
    const skipped = [];
    const importedAt = new Date().toISOString();
    for (const r of body) {
      const get = (k) => (idx[k] === undefined ? '' : (r[idx[k]] || '').trim());
      const date = parseDate(get('date'));
      const amount = parseAmount(get('amount'));
      const raw = get('description');
      if (!date || amount === null || !raw) {
        skipped.push(r);
        continue;
      }
      const { category, sub_category } = applyRules(raw, get('category') || null, get('sub_category') || null);
      const account = [get('institution'), get('account')].filter(Boolean).join(' ') || null;
      const key = `${date}|${raw}|${amount}|${account}`;
      seen[key] = (seen[key] || 0) + 1;
      // Bank rows repeat the raw description in Notes; keep only real notes.
      const notes = sanitize(get('notes'));
      rows.push({
        id: await hash(`${key}|${seen[key]}`),
        date,
        description: sanitize(raw) || raw.slice(0, 40),
        amount,
        category,
        sub_category,
        property: get('property') || null,
        account,
        platform: platformOf(raw, category),
        notes: notes && notes !== sanitize(raw) ? notes : null,
        imported_at: importedAt,
      });
    }
    return { rows, skipped, missing: [], header };
  }

  globalThis.FinanceImport = { parseCsv, parseAmount, parseDate, sanitize, platformOf, applyRules, prepare };
})();
