// Reads bucket colors from an unpacked expenses workbook (.xlsx): the
// legend in column J and each log row's fill color (column A). Resolves
// theme colors + tints to hex. Usage: node read-colors.js <unpacked dir>
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');

// Theme palette, in Excel's index order (lt1, dk1, lt2, dk2, accent1-6, hlink, folHlink).
const scheme = read('xl/theme/theme1.xml').match(/<a:clrScheme[\s\S]*?<\/a:clrScheme>/)[0];
const grab = (tag) => {
  const m = scheme.match(new RegExp(`<a:${tag}>[^]*?(?:srgbClr val="([0-9A-F]{6})"|lastClr="([0-9A-F]{6})")`, 'i'));
  return m[1] || m[2];
};
const theme = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'].map(grab);

function tintHex(hex, tint) {
  if (!tint) return hex;
  let [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const f = (p, q, t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  [r, g, b] = s === 0 ? [l, l, l] : [f(p, q, h + 1 / 3), f(p, q, h), f(p, q, h - 1 / 3)];
  return [r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function colorOf(xml) {
  if (!xml) return null;
  const rgb = xml.match(/rgb="(?:FF)?([0-9A-F]{6})"/i);
  if (rgb) return rgb[1].toUpperCase();
  const th = xml.match(/theme="(\d+)"/);
  if (!th) return null;
  const tint = Number((xml.match(/tint="([-0-9.E]+)"/i) || [0, 0])[1]);
  return tintHex(theme[Number(th[1])], tint);
}

const styles = read('xl/styles.xml');
const fills = [...styles.match(/<fills[^>]*>([\s\S]*?)<\/fills>/)[1].matchAll(/<fill>([\s\S]*?)<\/fill>/g)]
  .map((m) => (/patternType="none"/.test(m[1]) ? null : colorOf((m[1].match(/<fgColor[^>]*\/?>/) || [])[0])));
const xfs = [...styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)[1].matchAll(/<xf ([^>]*?)\/?>/g)]
  .map((m) => Number((m[1].match(/fillId="(\d+)"/) || [0, 0])[1]));
const shared = [...read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)]
  .map((m) => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('').replace(/&amp;/g, '&'));

function sheetCells(file) {
  const xml = read(`xl/worksheets/${file}`);
  const rows = {};
  for (const c of xml.matchAll(/<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const [, col, row, attrs, inner] = c;
    const s = Number((attrs.match(/ s="(\d+)"/) || [0, 0])[1]);
    const t = (attrs.match(/ t="(\w+)"/) || [])[1];
    let v = inner && (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
    if (t === 's' && v !== undefined) v = shared[Number(v)];
    (rows[row] ??= {})[col] = { v, fill: fills[xfs[s]] };
  }
  return rows;
}

// Excel stores dates as serial day numbers.
const serialToIso = (n) => new Date(Date.UTC(1899, 11, 30) + Number(n) * 86400000).toISOString().slice(0, 10);

const result = {};
for (const [year, file] of [['2025', 'sheet1.xml'], ['2026', 'sheet2.xml']]) {
  const rows = sheetCells(file);
  const legend = {};
  Object.values(rows).forEach((r) => {
    const name = r.J && r.J.v && r.J.v.trim();
    if (name && r.J.fill && !/mileage$|expenses|hours|^\d/i.test(name) && !/^2\d{3}/.test(name)) legend[name] = r.J.fill;
  });
  const log = Object.entries(rows)
    .filter(([n, r]) => Number(n) > 3 && r.A && r.A.v && /^\d+(\.\d+)?$/.test(r.A.v) && r.B && r.B.v)
    .map(([n, r]) => ({ row: Number(n), date: serialToIso(r.A.v), description: r.B.v, fill: r.A.fill }));
  result[year] = { legend, log };
}
console.log(JSON.stringify(result));
