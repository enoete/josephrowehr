// Usage: node tests/check.js <path to a Timecard Report CSV>
// Prints what the engine makes of an export: where punches land, and clock totals against rebuilt totals.
const fs = require('fs'); const E = require('../public/assets/engine.js');
const parsed = E.parseCsv(fs.readFileSync(process.argv[2], 'utf8'));
console.log('period', parsed.start, parsed.end, '| employees', parsed.employees.length, '| split days detected:', E.detectSplitDays(parsed));
for (const [name, cutoff] of [['as exported', ''], ['rebuilt', '16:30']]) {
  const b = E.build(parsed, { cutoff });
  const byDow = [0, 0, 0, 0, 0, 0, 0];
  for (const p of b.people) for (const d of p.days) if (d.status !== 'partial') byDow[d.dow] += d.punches.length;
  console.log(`\n== ${name} == punches by weekday`, E.DAYS.map((n, i) => n + ':' + byDow[i]).join(' '), '| closed:', b.closed.join(','));
  for (const p of b.people) console.log(' ', p.name.padEnd(20), 'clock', (E.fmtDur(p.clockTotalMin) || '-').padStart(6), '| rebuilt', E.fmtDur(p.totalMin).padStart(6),
    '| days', String(p.daysWorked).padStart(2), '| attention', p.attention, '| late', p.late, '| early', p.early, '| absent', p.absent, '| assumed days', p.assumedDays);
}
if (process.argv[3]) { const b = E.build(parsed, {}); const p = b.people.find((x) => x.name.startsWith(process.argv[3]));
  for (const d of p.days) console.log(E.fmtDate(d.date).padEnd(11), d.status.padEnd(9), E.fmtDur(d.minutes).padStart(5), ' ', d.punches.map((x) => `${x.type} ${E.fmtTime(x.min)}${x.kind && x.kind !== 'clock' ? '(' + x.kind + ')' : ''}`).join(', ')); }
