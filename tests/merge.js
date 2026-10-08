// Usage: node tests/merge.js <full export.csv>
// Cuts one export into overlapping pieces, uploads them in awkward orders, and checks the combined record
// gives exactly the same days and hours as the single full file.
const fs = require('fs'); const E = require('../public/assets/engine.js');
const full = fs.readFileSync(process.argv[2], 'utf8');
const us = (iso) => `${iso.slice(5, 7)}/${iso.slice(8)}/${iso.slice(0, 4)}`;
function cut(text, from, to) {               // keep report days from..to, as if the clock had exported that range
  const out = []; let keep = true;
  for (const line of text.split(/\r?\n/)) {
    const c = line.split(',');
    if (c[0] === 'Pay Period') { out.push(`Pay Period,,,${us(from)}-${us(to)},`); continue; }
    const m = /^(\d\d)\/(\d\d)\/(\d{4})$/.exec(c[1] || '');
    if (m) { const iso = `${m[3]}-${m[1]}-${m[2]}`; keep = iso >= from && iso <= to; }
    else if (c[0] === 'Total Hours' || c[0] === 'Employee' || c[0] === 'Date' || !line.trim() || c[0] === '') keep = keep || !line.trim() || c[0] !== '';
    if (c[0] === 'Employee' || c[0] === 'Date' || c[0] === 'Total Hours' || !line.trim() || /Timecard Report/.test(line)) { out.push(line); keep = c[0] === 'Employee' || c[0] === 'Date' ? true : keep; continue; }
    if (keep) out.push(line);
  }
  return out.join('\n');
}
const S = { cutoff: '16:30' };
const summary = (b) => b.people.map((p) => `${p.name}:${E.fmtDur(p.totalMin)}:${p.days.map((d) => d.status[0] + d.minutes).join('')}`).join(' | ');
const range = { from: '2026-09-02', to: '2026-09-21' };
const ref = summary(E.build(E.merge([{ id: 'full', csv: full, uploadedAt: '1' }]), S, {}, range));
const A = cut(full, '2026-09-01', '2026-09-10'), B = cut(full, '2026-09-08', '2026-09-21'), C = cut(full, '2026-09-11', '2026-09-21');
const cases = {
  'two overlapping files': [['a', A, '1'], ['b', B, '2']],
  'same, uploaded newest first': [['b', B, '1'], ['a', A, '2']],
  'back-to-back files': [['a', A, '1'], ['c', C, '2']],
  'full file uploaded twice': [['f1', full, '1'], ['f2', full, '2']],
  'pieces plus the full file': [['a', A, '1'], ['f', full, '2'], ['c', C, '3']],
};
let ok = true;
for (const [name, ups] of Object.entries(cases)) {
  const got = summary(E.build(E.merge(ups.map(([id, csv, at]) => ({ id, csv, uploadedAt: at }))), S, {}, range));
  const same = got === ref; ok = ok && same; console.log(same ? 'same as full file:' : 'DIFFERENT:', name);
}
// A file exported before the day was over must give way to a later, longer export.
const early = full.replace(/,,08:06 AM,11:44 AM,03:38,03:38,/, ',,08:06 AM,,,,Missing OUT');
const got = summary(E.build(E.merge([{ id: 'early', csv: early, uploadedAt: '2' }, { id: 'a', csv: A, uploadedAt: '1' }, { id: 'late', csv: cut(full, '2026-09-09', '2026-09-21'), uploadedAt: '0' }]), S, {}, range));
console.log(got === ref ? 'same as full file:' : 'DIFFERENT:', 'incomplete early export replaced by a later one'); ok = ok && got === ref;
process.exit(ok ? 0 : 1);
