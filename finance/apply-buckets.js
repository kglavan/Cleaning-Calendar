// Sets fin_activity.bucket for the imported workbook rows from each row's
// fill color in the expenses workbook (data/colors.json, made by
// read-colors.js). Rows are matched on date + description.
//   node apply-buckets.js --check   -> report only
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(HERE, '..', '.env') });

// Workbook colors -> bucket names used on the Finance page.
export const BUCKET_BY_COLOR = {
  E97132: 'Meals',
  '4EA72E': 'General Supplies',
  A02B93: 'Shipping',
  156082: 'Software',
  '196B24': 'Parking / Mileage',
  '0F9ED5': 'Legal Fees',
  '7F6000': 'Maintenance & Remodelling',
  CC0000: 'Cleaning',
  '8ED873': 'Home Costs',
};

const colors = JSON.parse(fs.readFileSync(path.join(HERE, 'data', 'colors.json'), 'utf8'));
const log = [...colors['2025'].log, ...colors['2026'].log];
const norm = (s) => String(s || '').trim().toLowerCase();

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data: rows, error } = await db.from('fin_activity').select('id, date, description, notes').eq('source', 'workbook');
if (error) throw error;

// The 2/14/2025 ceiling fan row was re-dated to 2026 on import.
const originalDate = (r) => (/said 2\/14\/2025/.test(r.notes || '') ? '2025-02-14' : r.date);
const used = new Set();
const updates = [];
const unmatched = [];
for (const r of rows) {
  const i = log.findIndex((l, k) => !used.has(k) && l.date === originalDate(r) && norm(l.description) === norm(r.description));
  if (i < 0) { unmatched.push(r); continue; }
  used.add(i);
  const bucket = BUCKET_BY_COLOR[log[i].fill];
  if (!bucket) { unmatched.push({ ...r, fill: log[i].fill }); continue; }
  updates.push({ id: r.id, bucket });
}
const counts = {};
updates.forEach((u) => (counts[u.bucket] = (counts[u.bucket] || 0) + 1));
console.log(`${updates.length} of ${rows.length} rows get a bucket`, counts);
if (unmatched.length) console.log('unmatched:', unmatched.map((u) => `${u.date} ${u.description}${u.fill ? ' fill ' + u.fill : ''}`));
console.log('workbook rows not used:', log.filter((_, k) => !used.has(k)).map((l) => `${l.date} ${l.description} ${l.fill}`));

if (!process.argv.includes('--check')) {
  for (const u of updates) {
    const { error: e } = await db.from('fin_activity').update({ bucket: u.bucket }).eq('id', u.id);
    if (e) throw e;
  }
  console.log('Buckets saved.');
}
