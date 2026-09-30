// Loads the expenses workbook history (data/expenses-workbook-2025-2026.csv,
// transcribed from "1143 Autumn Star Point Expenses.xlsx") into fin_activity.
// Re-running replaces the previously imported workbook rows, so it's safe to
// run again after fixing the CSV. Uses the calendar's own ../.env.
//
//   npm run import-workbook            -> import
//   node import-workbook.js --check    -> just print totals, change nothing
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(HERE, '..', '.env') });

// Minimal CSV parser (quoted fields, "" escapes).
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
  return rows;
}

function isoDate(mdy) {
  const [m, d, y] = mdy.split('/').map(Number);
  const year = y < 100 ? 2000 + y : y;
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const num = (s) => (s === '' || s == null ? null : Number(s));

const [header, ...rows] = parseCsv(fs.readFileSync(path.join(HERE, 'data', 'expenses-workbook-2025-2026.csv'), 'utf8'));
const records = rows.map((r) => {
  const o = Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']));
  return {
    date: isoDate(o.date),
    description: o.description,
    attendees: o.attendees || null,
    purpose: o.purpose || null,
    vendor: o.vendor || null,
    miles: num(o.miles) ?? 0,
    amount: num(o.amount),
    hours: num(o.hours) ?? 0,
    notes: o.notes || null,
    source: 'workbook',
  };
});

const byYear = {};
for (const r of records) {
  const y = r.date.slice(0, 4);
  byYear[y] ??= { rows: 0, miles: 0, hours: 0 };
  byYear[y].rows++;
  byYear[y].miles += r.miles;
  byYear[y].hours += r.hours;
}
console.log(`${records.length} workbook rows`, byYear);

if (!process.argv.includes('--check')) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the calendar .env');
  }
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { error: delErr } = await db.from('fin_activity').delete().eq('source', 'workbook');
  if (delErr) throw delErr;
  const { error } = await db.from('fin_activity').insert(records);
  if (error) throw error;
  console.log('Imported into fin_activity.');
}
