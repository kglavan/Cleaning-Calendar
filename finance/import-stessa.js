// Imports a Stessa "Export CSV" into fin_transactions using the same rules
// as the Finance page's Import tab (public/finance-import.js). Re-importing
// is safe: existing transactions are updated, not duplicated.
//
//   node import-stessa.js ../Transactions.csv --check   -> preview only
//   node import-stessa.js ../Transactions.csv           -> import
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import '../public/finance-import.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(HERE, '..', '.env') });

const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!file) throw new Error('Usage: node import-stessa.js <Transactions.csv> [--check]');

const hash = async (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
const { rows, skipped, missing, header } = await globalThis.FinanceImport.prepare(fs.readFileSync(file, 'utf8'), hash);
if (missing.length) throw new Error(`Missing column(s) ${missing.join(', ')}. Columns: ${header.join(' | ')}`);

const dates = rows.map((r) => r.date).sort();
console.log(`${rows.length} transactions, ${dates[0]} to ${dates[dates.length - 1]}; ${skipped.length} skipped`);
console.log('accounts:', [...new Set(rows.map((r) => r.account || '(none - e.g. Venmo entries)'))].join(' | '));
const uncategorized = rows.filter((r) => !r.category || /uncategorized/i.test(r.category));
console.log('uncategorized:', uncategorized.length, uncategorized.slice(0, 5).map((r) => `${r.date} ${r.description} ${r.amount}`));

if (!process.argv.includes('--check')) {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await db.from('fin_transactions').upsert(rows.slice(i, i + 200), { onConflict: 'id' });
    if (error) throw error;
  }
  console.log('Imported into fin_transactions.');
}
