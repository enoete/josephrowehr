/* Timecard engine: reads the time clock's "Timecard Report" CSV and rebuilds each person's working days.
   Pure logic with no page or server dependencies, so it runs in the browser and in tests alike. */
(function (root, factory) {
  const E = factory();
  if (typeof module === 'object' && module.exports) module.exports = E; else root.Engine = E;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const pad = (n) => String(n).padStart(2, '0');

  // ---- time and date helpers ----
  function clockToMin(s) {                       // "08:15 AM" or "16:30" -> minutes after midnight
    const m = /^(\d{1,2}):(\d{2})\s*([AP]M)?$/i.exec(String(s || '').trim());
    if (!m) return null;
    let h = +m[1]; const mi = +m[2];
    if (m[3]) { const pm = m[3].toUpperCase() === 'PM'; if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
    return h > 23 || mi > 59 ? null : h * 60 + mi;
  }
  function durToMin(s) { const m = /^(\d+):(\d{2})$/.exec(String(s || '').trim()); return m ? +m[1] * 60 + +m[2] : null; }
  function fmtTime(min) { if (min == null) return ''; const h = Math.floor(min / 60), m = min % 60; return `${h % 12 || 12}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`; }
  function fmtDur(min) { if (min == null) return ''; const a = Math.abs(Math.round(min)); return `${min < 0 ? '-' : ''}${Math.floor(a / 60)}:${pad(a % 60)}`; }
  function fmtDec(min) { return (Math.round((min / 60) * 100) / 100).toFixed(2); }
  function usToIso(s) { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '').trim()); return m ? `${m[3]}-${pad(m[1])}-${pad(m[2])}` : null; }
  const toDate = (iso) => new Date(iso + 'T00:00:00Z');
  function addDays(iso, n) { const d = toDate(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  const dow = (iso) => toDate(iso).getUTCDay();   // 0 = Sunday
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(iso, long) { const d = toDate(iso); return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${long ? ' ' + d.getUTCFullYear() : ''}`; }

  function splitCsvLine(line) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur); return out.map((s) => s.trim());
  }

  // ---- 1. Read the export exactly as the clock wrote it ----
  function parseCsv(text) {
    const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
    const employees = []; let emp = null, label = null, period = null;
    for (const raw of lines) {
      if (!raw.trim()) continue;
      const c = splitCsvLine(raw);
      if (c[0] === 'Pay Period') { period = c[3] || period; emp = null; label = null; continue; }
      if (c[0] === 'Employee') {
        const m = /^(.*?)\s*\((\w+)\)\s*$/.exec(c[3] || '');
        emp = { id: m ? m[2] : String(employees.length + 1), name: (m ? m[1] : c[3] || 'Unknown').trim(), clockTotalMin: null, rows: [], period };
        employees.push(emp); label = null; continue;
      }
      if (!emp || c[0] === 'Date') continue;
      if (c[0] === 'Total Hours') { emp.clockTotalMin = durToMin(c[5]); continue; }
      const iso = usToIso(c[1]);
      if (iso) label = iso; else if (c[0] || c[1]) continue;    // not a day row or a continuation row
      if (!label) continue;
      const inMin = clockToMin(c[2]), outMin = clockToMin(c[3]);
      const dailyMin = durToMin(c[5]);
      if (inMin == null && outMin == null && dailyMin == null) continue;
      emp.rows.push({ label, inMin, outMin, workMin: durToMin(c[4]), dailyMin, note: c[6] || '' });
    }
    const p = /(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})/.exec(period || '');
    if (!employees.length || !p) throw new Error('This file does not look like a Timecard Report export from the time clock.');
    // Tidy names such as "DOREEN BARON" into "Doreen Baron".
    for (const e of employees) if (e.name === e.name.toUpperCase() || /^[A-Z]{3,}\s/.test(e.name)) e.name = e.name.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
    return { start: usToIso(p[1]), end: usToIso(p[2]), employees };
  }

  const DEFAULTS = {
    cutoff: '16:30',      // time of day at which the clock starts a new report day; '' = midnight (no correction)
    workStart: '08:30', workEnd: '16:30', graceMin: 10,
    lunchMin: 0,          // unpaid lunch taken off days recorded as one unbroken stretch
    lunchAfterMin: 360,   // ...when that stretch is at least this long
    assumeSameLabel: true, // two punches with the same IN/OUT label, hours apart, count as arrival and departure
    holidays: [],         // ISO dates the office was closed
    workDays: [1, 2, 3, 4, 5],
  };

  // Did the clock split working days across two report days? True when unpaired evening punches sit
  // on one report day and unpaired morning punches on the same or previous one, week after week.
  function detectSplitDays(parsed) {
    let sunPunch = 0, friMorning = 0, friEvening = 0;
    for (const e of parsed.employees) for (const r of e.rows) {
      const d = dow(r.label), t = r.inMin != null ? r.inMin : r.outMin;
      if (t == null) continue;
      if (d === 0) sunPunch++;
      if (d === 5) { if (t < 720) friMorning++; else friEvening++; }
    }
    return sunPunch >= 3 && friMorning <= Math.max(1, friEvening / 3);
  }

  // ---- 2. Combine every upload into one record ----
  // Each upload covers a date range. For every person and every report day, one copy is kept: the one from the
  // upload whose range runs furthest past that day (it was exported later, so it saw the whole day), then the one
  // with more punches recorded, then the most recently uploaded. Re-uploads and overlaps never double-count.
  function merge(uploads) {
    const best = {}, names = {}, order = [], totals = [];
    const better = (a, b) => (a.end !== b.end ? a.end > b.end : a.punches !== b.punches ? a.punches > b.punches : String(a.at) >= String(b.at));
    const ranked = uploads.map((u) => ({ u, p: u.parsed || parseCsv(u.csv) }))
      .sort((a, b) => (a.p.end === b.p.end ? String(a.u.uploadedAt).localeCompare(String(b.u.uploadedAt)) : a.p.end < b.p.end ? -1 : 1));
    let from = null, to = null;
    for (const { u, p } of ranked) {
      totals.push({ start: p.start, end: p.end, byId: Object.fromEntries(p.employees.map((e) => [e.id, e.clockTotalMin])) });
      if (!from || p.start < from) from = p.start;
      if (!to || p.end > to) to = p.end;
      for (const e of p.employees) {
        if (!(e.id in names)) order.push(e.id);
        names[e.id] = e.name;
        const rowsByLabel = {};
        for (const r of e.rows) (rowsByLabel[r.label] = rowsByLabel[r.label] || []).push(r);
        for (let d = p.start; d <= p.end; d = addDays(d, 1)) {
          const rows = rowsByLabel[d] || [];
          const cand = { rows, upload: u.id, end: p.end, at: u.uploadedAt, punches: rows.reduce((a, r) => a + (r.inMin != null) + (r.outMin != null), 0) };
          const k = e.id + '|' + d;
          if (!best[k] || better(cand, best[k])) best[k] = cand;
        }
      }
    }
    const employees = order.map((id) => {
      const covered = new Set(), rows = [];
      for (const [k, v] of Object.entries(best)) {
        const [eid, d] = k.split('|');
        if (eid !== id) continue;
        covered.add(d); rows.push(...v.rows);
      }
      rows.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
      return { id, name: names[id], rows, covered };
    });
    employees.sort((a, b) => (+a.id || 0) - (+b.id || 0) || a.name.localeCompare(b.name));
    return { start: from, end: to, employees, source: best, totals };
  }

  // ---- 3. Rebuild real working days for a date range ----
  // data: a single parsed export or the result of merge(). range: { from, to } in ISO dates (defaults to all of it).
  function build(data, settingsIn, corrections, range) {
    const parsed = data;
    const S = Object.assign({}, DEFAULTS, settingsIn || {});
    corrections = corrections || {};
    const cutoff = S.cutoff ? clockToMin(S.cutoff) : null;
    const shift = cutoff != null && cutoff > 0;
    const startMin = clockToMin(S.workStart), endMin = clockToMin(S.workEnd);
    const holidays = new Set(S.holidays || []);
    const from = (range && range.from) || parsed.start, to = (range && range.to) || (shift ? addDays(parsed.end, 1) : parsed.end);
    const dates = []; for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
    const realDate = (label, min) => (shift && min < cutoff ? addDays(label, 1) : label);

    const people = parsed.employees.map((e) => {
      // Which report days the clock data covers for this person. A real day is complete only when every report day
      // that can hold its punches is covered (with a changeover, its morning sits on the report day before).
      const cov = e.covered || (() => { const c = new Set(); for (let d = parsed.start; d <= parsed.end; d = addDays(d, 1)) c.add(d); return c; })();
      const full = (d) => (shift ? cov.has(addDays(d, -1)) && cov.has(d) : cov.has(d));
      const some = (d) => cov.has(d) || (shift && cov.has(addDays(d, -1)));
      let clockMin = 0, clockAny = false;
      const byDate = {}; const day = (d) => (byDate[d] = byDate[d] || { spans: [], loose: [] });
      const byLabel = {};
      for (const r of e.rows) {
        const L = (byLabel[r.label] = byLabel[r.label] || { daily: null, pairs: [] });
        if (r.dailyMin != null) L.daily = r.dailyMin;
        if (r.inMin != null && r.outMin != null) {
          const sp = { in: r.inMin, out: r.outMin, min: r.workMin != null ? r.workMin : r.outMin - r.inMin, kind: 'clock', inSrc: 'clock', outSrc: 'clock' };
          day(realDate(r.label, r.inMin)).spans.push(sp); L.pairs.push(sp);
        } else if (r.inMin != null) day(realDate(r.label, r.inMin)).loose.push({ min: r.inMin, type: 'IN', src: 'clock' });
        else if (r.outMin != null) day(realDate(r.label, r.outMin)).loose.push({ min: r.outMin, type: 'OUT', src: 'clock' });
      }
      // The clock counts seconds, so its daily total can be a minute more than its rows add up to. Keep its figure.
      for (const [lab, L] of Object.entries(byLabel)) if (L.daily != null && lab >= from && lab <= to) { clockMin += L.daily; clockAny = true; }
      for (const L of Object.values(byLabel)) {
        if (L.daily == null || !L.pairs.length) continue;
        const delta = L.daily - L.pairs.reduce((a, s) => a + s.min, 0);
        if (delta > 0 && delta <= L.pairs.length + 1) L.pairs[L.pairs.length - 1].min += delta;
      }
      for (const [key, c] of Object.entries(corrections)) {
        const [id, d] = key.split('|');
        if (id !== e.id || !c) continue;
        for (const a of c.add || []) { const m = clockToMin(a.t); if (m != null) day(d).loose.push({ min: m, type: a.type === 'OUT' ? 'OUT' : 'IN', src: 'manual' }); }
      }

      const days = dates.map((date) => {
        const D = byDate[date] || { spans: [], loose: [] };
        const spans = D.spans.slice().sort((a, b) => a.in - b.in);
        const loose = D.loose.slice().sort((a, b) => a.min - b.min);
        const c = corrections[e.id + '|' + date] || {};
        // A second punch of the same kind within ten minutes is a double tap, not a missing punch.
        const others = (p) => spans.map((s) => ({ min: p.type === 'IN' ? s.in : s.out })).concat(loose.filter((q) => q !== p && q.type === p.type && !q.dup));
        for (const p of loose) if (p.src === 'clock' && others(p).some((q) => Math.abs(q.min - p.min) <= 10)) p.dup = true;
        const live = loose.filter((p) => !p.dup); const open = [];
        let pending = null;
        for (const p of live) {
          if (p.type === 'IN') { if (pending) open.push(pending); pending = p; }
          else if (pending && !spans.some((s) => s.in > pending.min && s.out < p.min)) {
            spans.push({ in: pending.min, out: p.min, min: p.min - pending.min, kind: pending.src === 'manual' || p.src === 'manual' ? 'manual' : 'recovered', inSrc: pending.src, outSrc: p.src }); pending = null;
          } else { if (pending) { open.push(pending); pending = null; } open.push(p); }
        }
        if (pending) open.push(pending);
        let unresolved = open;
        if (S.assumeSameLabel && !spans.length && open.length === 2 && open[0].type === open[1].type && open[1].min - open[0].min >= 120) {
          spans.push({ in: open[0].min, out: open[1].min, min: open[1].min - open[0].min, kind: 'assumed', inSrc: open[0].src, outSrc: open[1].src }); unresolved = [];
        }
        spans.sort((a, b) => a.in - b.in);
        let minutes = spans.reduce((a, s) => a + s.min, 0), lunch = 0;
        if (S.lunchMin > 0 && spans.length === 1 && spans[0].min >= S.lunchAfterMin) { lunch = Math.min(S.lunchMin, minutes); minutes -= lunch; }

        const wd = dow(date), isWorkDay = S.workDays.includes(wd);
        const any = spans.length || loose.length;
        const partial = !full(date);
        let status;
        if (partial) status = any || some(date) ? 'partial' : 'nodata';
        else if (!any) status = holidays.has(date) ? 'holiday' : isWorkDay ? 'absent' : 'off';
        else status = unresolved.length ? 'attention' : 'ok';
        const first = Math.min(spans.length ? spans[0].in : Infinity, ...unresolved.filter((p) => p.type === 'IN').map((p) => p.min));
        const lastSpanOut = spans.length ? spans[spans.length - 1].out : null;
        const endsCleanly = lastSpanOut != null && !unresolved.some((p) => p.min > lastSpanOut);
        const counted = status === 'ok' || status === 'attention';
        const lateMin = counted && isWorkDay && !holidays.has(date) && isFinite(first) && first > startMin + S.graceMin ? first - startMin : 0;
        const earlyMin = counted && isWorkDay && !holidays.has(date) && endsCleanly && lastSpanOut < endMin - S.graceMin ? endMin - lastSpanOut : 0;
        const punches = spans.flatMap((s) => [{ min: s.in, type: 'IN', kind: s.kind, src: s.inSrc }, { min: s.out, type: 'OUT', kind: s.kind, src: s.outSrc }])
          .concat(loose.map((p) => ({ min: p.min, type: p.type, kind: p.dup ? 'duplicate' : unresolved.includes(p) ? 'unresolved' : null, src: p.src })).filter((p) => p.kind))
          .sort((a, b) => a.min - b.min);
        return { date, dow: wd, status, spans, unresolved, duplicates: loose.filter((p) => p.dup), punches, minutes: partial ? 0 : minutes, lunch,
          firstIn: isFinite(first) ? first : null, lastOut: lastSpanOut, lateMin, earlyMin, note: c.note || '', manual: (c.add || []).slice(),
          kinds: Array.from(new Set(spans.map((s) => s.kind))), weekendWork: counted && !isWorkDay };
      });
      // When the range is exactly one export's pay period, show that export's own "Total Hours" figure.
      const whole = (parsed.totals || []).filter((t) => t.start === from && (t.end === to || addDays(t.end, 1) === to) && e.id in t.byId).pop();
      const clockTotalMin = whole ? whole.byId[e.id] : clockAny ? clockMin : e.covered ? null : e.clockTotalMin;
      return { id: e.id, name: e.name, clockTotalMin, days };
    });

    // A working day on which nobody clocked at all is treated as the office being closed, not as absences.
    const shown = people.filter((p) => p.days.some((d) => d.status !== 'nodata'));
    people.length = 0; people.push(...shown);
    const closed = new Set();
    dates.forEach((d, i) => {
      const withData = people.filter((p) => !['nodata', 'partial', 'off', 'holiday'].includes(p.days[i].status));
      if (withData.length > 1 && withData.every((p) => p.days[i].status === 'absent')) closed.add(d);
    });
    for (const p of people) {
      for (const d of p.days) if (closed.has(d.date)) d.status = 'closed';
      const cnt = (f) => p.days.filter(f).length;
      p.totalMin = p.days.reduce((a, d) => a + d.minutes, 0);
      p.daysWorked = cnt((d) => d.minutes > 0);
      p.attention = cnt((d) => d.status === 'attention');
      p.late = cnt((d) => d.lateMin > 0); p.early = cnt((d) => d.earlyMin > 0);
      p.absent = cnt((d) => d.status === 'absent');
      p.recoveredMin = p.days.reduce((a, d) => a + d.spans.filter((s) => s.kind !== 'clock').reduce((x, s) => x + s.min, 0), 0);
      p.assumedDays = cnt((d) => d.kinds.includes('assumed'));
    }
    const noData = dates.filter((d, i) => people.every((p) => p.days[i].status === 'nodata'));
    return { start: from, end: to, dates, shift, settings: S, closed: Array.from(closed), noData, people };
  }

  return { parseCsv, merge, build, detectSplitDays, DEFAULTS, clockToMin, fmtTime, fmtDur, fmtDec, fmtDate, addDays, dow, DAYS };
});
