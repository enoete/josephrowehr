/* HR Timecards front end: sign-in, uploads, reports, corrections and exports. No build step. */
(function () {
  'use strict';
  const E = window.Engine;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const STATUS = { ok: 'Complete', attention: 'Needs attention', absent: 'Absent', off: 'Weekend', closed: 'Office closed', holiday: 'Holiday', partial: 'Partly outside the uploaded files', nodata: 'No clock data yet' };
  const KIND = { recovered: 'Rebuilt', assumed: 'Assumed', manual: 'Corrected' };

  const state = { uploads: [], corrections: {}, saved: null, merged: null, range: null, built: null, tab: 'overview', person: null };

  async function api(action, body, query) {
    const url = 'api.php?do=' + action + (query ? '&' + query : '');
    const res = await fetch(url, body === undefined ? { credentials: 'same-origin' } : {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let json = {}; try { json = await res.json(); } catch (e) { /* not JSON */ }
    if (res.status === 401 && action !== 'login' && action !== 'me') { showLogin('Your session ended. Sign in again.'); }
    return { ok: res.ok, status: res.status, json };
  }
  function flash(msg, bad) { const f = $('#flash'); f.textContent = msg; f.hidden = !msg; f.classList.toggle('bad', !!bad); if (msg) setTimeout(() => { if (f.textContent === msg) f.hidden = true; }, 6000); }

  // ---------- sign-in ----------
  function showLogin(msg) { $('#app').hidden = true; $('#login').hidden = false; const e = $('#loginError'); e.hidden = !msg; e.textContent = msg || ''; $('#password').focus(); }
  async function start() {
    const me = await api('me');
    if (!me.ok) return showLogin('The server is not responding. Refresh the page, or contact your administrator.');
    if (!me.json.signedIn) return showLogin(me.json.ready ? '' : 'Sign-in has not been set up yet. Ask your administrator to finish the configuration.');
    $('#login').hidden = true; $('#app').hidden = false;
    if (!me.json.storage) flash('The server cannot save files yet. Ask your administrator to check the storage folder.', true);
    await loadData();
  }
  $('#loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault(); const b = $('#loginBtn'); b.disabled = true;
    const r = await api('login', { password: $('#password').value }); b.disabled = false;
    if (r.ok) { $('#password').value = ''; start(); } else showLogin(r.json.error || 'Sign-in failed. Try again.');
  });
  $('#logoutBtn').addEventListener('click', async () => { await api('logout', {}); state.merged = state.built = null; showLogin(''); });

  // ---------- data: every upload is combined into one record; reports cover any date range ----------
  const rangeLabel = (r) => `${E.fmtDate(r.from).slice(4)} to ${E.fmtDate(r.to, true).slice(4)}`;
  function settingsFor(data) {
    if (state.saved && state.saved.workStart) return Object.assign({}, E.DEFAULTS, state.saved);
    return Object.assign({}, E.DEFAULTS, { cutoff: data && data.employees.length && E.detectSplitDays(data) ? '16:30' : '' });
  }
  function payPeriods() {          // the date ranges of the uploaded files, newest first, without repeats
    const seen = new Set(), out = [];
    for (const u of state.uploads.slice().sort((a, b) => (a.end === b.end ? (a.start < b.start ? 1 : -1) : a.end < b.end ? 1 : -1))) {
      const k = u.start + '|' + u.end; if (!seen.has(k)) { seen.add(k); out.push({ from: u.start, to: u.end }); }
    }
    return out;
  }
  async function loadData(focus) {
    const r = await api('data'); if (!r.ok) return;
    state.saved = r.json.settings; state.corrections = r.json.corrections || {};
    state.uploads = (r.json.uploads || []).map((u) => { try { return Object.assign(u, { parsed: E.parseCsv(u.csv) }); } catch (e) { return null; } }).filter(Boolean);
    state.merged = state.uploads.length ? E.merge(state.uploads) : null;
    const periods = payPeriods();
    if (focus) state.range = focus;
    else if (!state.range || !state.merged) state.range = periods[0] || null;
    drawRangePicker(); renderUploads(); fillSettings();
    if (state.merged) rebuild(); else { state.built = null; renderAll(); go('uploads'); }
  }
  function drawRangePicker() {
    const sel = $('#periodSel'), periods = payPeriods(), r = state.range;
    const opts = periods.map((p) => [`${p.from}|${p.to}`, rangeLabel(p)]);
    if (state.merged) opts.push([`${state.merged.start}|${state.merged.end}`, 'All dates on record']);
    const cur = r ? `${r.from}|${r.to}` : '';
    if (r && !opts.some((o) => o[0] === cur)) opts.unshift([cur, rangeLabel(r)]);
    opts.push(['custom', 'Choose dates…']);
    sel.innerHTML = opts.map((o) => `<option value="${o[0]}">${esc(o[1])}</option>`).join('');
    sel.value = cur || 'custom'; sel.disabled = !state.merged;
    $('#rangeFrom').value = r ? r.from : ''; $('#rangeTo').value = r ? r.to : '';
    $('#customRange').hidden = true;
  }
  $('#periodSel').addEventListener('change', (e) => {
    if (e.target.value === 'custom') { $('#customRange').hidden = false; $('#rangeFrom').focus(); return; }
    const [from, to] = e.target.value.split('|'); state.range = { from, to }; $('#customRange').hidden = true; rebuild();
  });
  $('#customRange').addEventListener('submit', (e) => {
    e.preventDefault(); const from = $('#rangeFrom').value, to = $('#rangeTo').value;
    if (!from || !to || from > to) { flash('Choose a start date on or before the end date.', true); return; }
    state.range = { from, to }; drawRangePicker(); rebuild();
  });
  function rebuild() {
    if (!state.merged || !state.range) return;
    state.settings = settingsFor(state.merged);
    state.built = E.build(state.merged, state.settings, state.corrections, state.range);
    if (!state.built.people.length) { renderAll(); return; }
    if (!state.person || !state.built.people.some((p) => p.id === state.person)) state.person = state.built.people[0].id;
    renderAll();
  }

  // ---------- navigation ----------
  function go(tab) {
    state.tab = tab;
    document.querySelectorAll('.tab').forEach((x) => (x.dataset.tab === tab ? x.setAttribute('aria-current', 'page') : x.removeAttribute('aria-current')));
    document.querySelectorAll('.pane').forEach((p) => { p.hidden = p.id !== 'tab-' + tab; });
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => go(b.dataset.tab)));

  // ---------- reports: each is { title, sub, file, cols, rows } so the screen and every export share one source ----------
  const B = () => state.built;
  const span = () => rangeLabel({ from: B().start, to: B().end });
  function rSummary() {
    return { title: 'Hours summary', sub: span(), file: 'hours-summary',
      cols: [['Employee', 'l'], ['ID', 'l'], ['Days worked'], ['Hours'], ['Hours (decimal)'], ['Clock reported'], ['Rebuilt by portal'], ['Needs attention'], ['Late'], ['Left early'], ['Absent']],
      rows: B().people.map((p) => [p.name, p.id, p.daysWorked, E.fmtDur(p.totalMin), +E.fmtDec(p.totalMin), p.clockTotalMin == null ? '' : E.fmtDur(p.clockTotalMin), E.fmtDur(p.recoveredMin), p.attention, p.late, p.early, p.absent]) };
  }
  const punchText = (d) => d.punches.filter((x) => x.kind !== 'duplicate').map((x) => `${x.type === 'IN' ? 'In' : 'Out'} ${E.fmtTime(x.min)}`).join(', ');
  const dayHow = (d) => d.kinds.filter((k) => KIND[k]).map((k) => KIND[k]).join(', ');
  function rDaily(people) {
    const rows = [];
    for (const p of people || B().people) for (const d of p.days) {
      if ((d.status === 'off' && !d.punches.length) || d.status === 'nodata') continue;
      rows.push([p.name, d.date, E.DAYS[d.dow], d.firstIn == null ? '' : E.fmtTime(d.firstIn), d.lastOut == null ? '' : E.fmtTime(d.lastOut), punchText(d),
        d.minutes ? E.fmtDur(d.minutes) : '', d.minutes ? +E.fmtDec(d.minutes) : '', d.lunch ? d.lunch : '', STATUS[d.status], dayHow(d), d.note]);
    }
    return { title: 'Daily detail', sub: span(), file: 'daily-detail',
      cols: [['Employee', 'l'], ['Date', 'l'], ['Day', 'l'], ['First in'], ['Last out'], ['All punches', 'l'], ['Hours'], ['Hours (decimal)'], ['Lunch taken off (min)'], ['Status', 'l'], ['How worked out', 'l'], ['Note', 'l']], rows };
  }
  function missing(d) { return d.unresolved.map((u) => (u.type === 'IN' ? `No clock-out after ${E.fmtTime(u.min)}` : `No clock-in before ${E.fmtTime(u.min)}`)).join('; '); }
  function rAttention() {
    const rows = [];
    for (const p of B().people) for (const d of p.days) if (d.status === 'attention') rows.push([p.name, d.date, E.DAYS[d.dow], punchText(d), missing(d), d.minutes ? E.fmtDur(d.minutes) : '0:00', d.note, p.id]);
    return { title: 'Days needing attention', sub: span(), file: 'needs-attention', hide: 1,
      cols: [['Employee', 'l'], ['Date', 'l'], ['Day', 'l'], ['Punches recorded', 'l'], ['What is missing', 'l'], ['Hours counted so far'], ['Note', 'l']], rows };
  }
  function rPunctuality() {
    const rows = [];
    for (const p of B().people) for (const d of p.days) {
      if (d.lateMin) rows.push([p.name, d.date, E.DAYS[d.dow], 'Late arrival', `Clocked in ${E.fmtTime(d.firstIn)}`, d.lateMin]);
      if (d.earlyMin) rows.push([p.name, d.date, E.DAYS[d.dow], 'Left early', `Clocked out ${E.fmtTime(d.lastOut)}`, d.earlyMin]);
      if (d.status === 'absent') rows.push([p.name, d.date, E.DAYS[d.dow], 'Absent', 'No punches recorded', '']);
      if (d.weekendWork) rows.push([p.name, d.date, E.DAYS[d.dow], 'Weekend work', `${E.fmtDur(d.minutes)} hours`, '']);
    }
    return { title: 'Punctuality and absence', sub: `${span()}. Working day ${E.fmtTime(E.clockToMin(state.settings.workStart))} to ${E.fmtTime(E.clockToMin(state.settings.workEnd))}, ${state.settings.graceMin} minute grace.`, file: 'punctuality',
      cols: [['Employee', 'l'], ['Date', 'l'], ['Day', 'l'], ['Event', 'l'], ['Detail', 'l'], ['Minutes']], rows };
  }

  function table(rep, opts) {
    opts = opts || {}; const n = rep.cols.length;
    const head = rep.cols.map((c) => `<th class="${c[1] === 'l' ? 'l' : ''}">${esc(c[0])}</th>`).join('') + (opts.action ? '<th class="no-print"></th>' : '');
    const body = rep.rows.map((r, i) => '<tr>' + r.slice(0, n).map((v, j) => `<td class="${rep.cols[j][1] === 'l' ? 'l' : ''}">${opts.cell ? opts.cell(v, j, r) : esc(/^\d{4}-\d\d-\d\d$/.test(v) ? E.fmtDate(v).slice(4) : v)}</td>`).join('') +
      (opts.action ? `<td class="no-print act">${opts.action(r, i)}</td>` : '') + '</tr>').join('');
    return rep.rows.length ? `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>` : `<p class="empty">${esc(opts.empty || 'Nothing to show for this pay period.')}</p>`;
  }
  const exportBar = (key, extra) => `<div class="export no-print">${extra || ''}<button type="button" class="ghost-btn" data-x="xlsx" data-r="${key}">Excel</button><button type="button" class="ghost-btn" data-x="csv" data-r="${key}">CSV</button><button type="button" class="ghost-btn" data-x="print" data-r="${key}">Print or save as PDF</button></div>`;
  const REPORTS = { summary: rSummary, daily: () => rDaily(), attention: rAttention, punctuality: rPunctuality, person: () => { const p = B().people.find((x) => x.id === state.person); const r = rDaily([p]); r.title = `Timecard: ${p.name}`; r.file = 'timecard-' + p.name.toLowerCase().replace(/[^a-z]+/g, '-'); return r; } };

  // ---------- exports ----------
  const aoa = (rep) => [rep.cols.map((c) => c[0])].concat(rep.rows.map((r) => r.slice(0, rep.cols.length)));
  const fileName = (rep, ext) => `${rep.file}-${B().start}-to-${B().end}.${ext}`;
  function save(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
  function toCsv(rep) {
    // A leading apostrophe stops a spreadsheet treating text that starts with = + - @ as a formula.
    const q = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s) && typeof v !== 'number') s = "'" + s; return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    save(new Blob(['﻿' + aoa(rep).map((r) => r.map(q).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }), fileName(rep, 'csv'));
  }
  function sheet(rep) { const ws = XLSX.utils.aoa_to_sheet(aoa(rep)); ws['!cols'] = rep.cols.map((c, i) => ({ wch: Math.min(48, Math.max(c[0].length, ...rep.rows.map((r) => String(r[i] == null ? '' : r[i]).length)) + 2) })); return ws; }
  function toXlsx(reps, name) { const wb = XLSX.utils.book_new(); for (const r of reps) XLSX.utils.book_append_sheet(wb, sheet(r), r.title.replace(/[:\\/?*[\]]/g, '').slice(0, 31)); XLSX.writeFile(wb, name); }
  function printHtml(html) { $('#printArea').innerHTML = html; window.print(); }
  const printHead = (rep) => `<div class="print-head"><strong>Joseph Rowe, Attorneys-at-Law</strong><h1>${esc(rep.title)}</h1><p>${esc(rep.sub)}</p></div>`;
  function timecardPrint(p) {
    const rep = rDaily([p]), keep = [1, 3, 4, 5, 6, 9, 10, 11];   // date, first in, last out, punches, hours, status, how, note
    rep.cols = keep.map((i) => rep.cols[i]); rep.rows = rep.rows.map((r) => keep.map((i) => (i === 1 ? E.fmtDate(r[1]) : r[i])));
    return `<section class="sheet">${printHead({ title: `Timecard: ${p.name}`, sub: `${span()}. Employee ID ${p.id}.` })}${table(rep)}
      <p class="print-total">Total hours: <strong>${E.fmtDur(p.totalMin)}</strong> (${E.fmtDec(p.totalMin)} decimal) over ${p.daysWorked} days</p>
      <div class="sign"><span>Employee signature</span><span>HR manager signature</span><span>Date</span></div></section>`;
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-x]'); if (!b || !B()) return;
    const kind = b.dataset.x, key = b.dataset.r;
    if (key === 'all') return toXlsx([rSummary(), rDaily(), rAttention(), rPunctuality()], `timecard-reports-${B().start}-to-${B().end}.xlsx`);
    if (key === 'cards') return printHtml(B().people.map(timecardPrint).join(''));
    const rep = REPORTS[key]();
    if (kind === 'csv') toCsv(rep);
    else if (kind === 'xlsx') toXlsx([rep], fileName(rep, 'xlsx'));
    else if (key === 'person') printHtml(timecardPrint(B().people.find((x) => x.id === state.person)));
    else printHtml(`<section class="sheet">${printHead(rep)}${table(rep)}</section>`);
  });

  // ---------- screens ----------
  const chip = (text, cls) => `<span class="chip ${cls || ''}">${esc(text)}</span>`;
  const statusChip = (d) => chip(STATUS[d.status], d.status);
  function renderAll() {
    const has = !!(B() && B().people.length);
    const msg = state.merged ? ['No clock data for these dates', 'Nothing has been uploaded for this date range yet. Choose other dates, or upload the export that covers them.'] : ['Nothing uploaded yet', "Upload the time clock's export to see reports here."];
    for (const t of ['overview', 'timecards', 'attention', 'punctuality']) if (!has) $('#tab-' + t).innerHTML = `<div class="pane-head"><div><h1>${msg[0]}</h1><p class="lede">${msg[1]}</p></div></div><button type="button" class="btn" data-go="uploads">Go to uploads</button>`;
    const badge = $('#attnCount'); const total = has ? B().people.reduce((a, p) => a + p.attention, 0) : 0;
    badge.hidden = !total; badge.textContent = total;
    if (!has) return;
    renderOverview(); renderTimecards(); renderAttention(); renderPunctuality();
  }
  document.addEventListener('click', (e) => { const g = e.target.closest('[data-go]'); if (g) { if (g.dataset.person) { state.person = g.dataset.person; renderTimecards(); } go(g.dataset.go); } });

  function renderOverview() {
    const b = B(), sum = (f) => b.people.reduce((a, p) => a + f(p), 0);
    const total = sum((p) => p.totalMin), clock = sum((p) => p.clockTotalMin || 0), rep = rSummary();
    const split = b.shift ? `<div class="notice"><strong>The clock's own totals are not reliable for this export.</strong>
      <p>The clock is set to start a new day at ${E.fmtTime(E.clockToMin(b.settings.cutoff))} instead of midnight, so it filed each morning clock-in under the day before and could not match it to that evening's clock-out. Its own figures come to ${E.fmtDur(clock)} hours for these dates. Put back together day by day, the same punches come to ${E.fmtDur(total)} hours.</p>
      <p>Every figure the portal rebuilt is marked, and both totals appear in the table below so you can compare. <button type="button" class="link" data-go="settings">Review how the file is read</button></p></div>` : '';
    const closed = b.closed.length ? `<p class="muted small">Treated as office closed (nobody clocked in): ${b.closed.map((d) => E.fmtDate(d)).join(', ')}.</p>` : '';
    const gaps = b.noData.length ? `<p class="caution">No clock data has been uploaded yet for ${b.noData.length === 1 ? E.fmtDate(b.noData[0]) : `${E.fmtDate(b.noData[0])} to ${E.fmtDate(b.noData[b.noData.length - 1])}`}. Those days are left out, not counted as absences.</p>` : '';
    $('#tab-overview').innerHTML = `<div class="pane-head"><div><h1>${esc(span())}</h1>
        <p class="lede">${b.people.length} employees. Built from ${state.uploads.length} uploaded ${state.uploads.length === 1 ? 'file' : 'files'}, combined so each day is counted once.</p></div>
        ${exportBar('summary', '<button type="button" class="btn small" data-x="xlsx" data-r="all">Download all reports (Excel)</button>')}</div>
      ${split}${gaps}
      <div class="stats">
        <div class="stat"><span>Hours worked</span><strong>${E.fmtDur(total)}</strong><em>${b.shift ? `clock reported ${E.fmtDur(clock)}` : `${E.fmtDec(total)} decimal`}</em></div>
        <button type="button" class="stat link-stat" data-go="attention"><span>Days needing attention</span><strong>${sum((p) => p.attention)}</strong><em>a punch is missing</em></button>
        <button type="button" class="stat link-stat" data-go="punctuality"><span>Late arrivals</span><strong>${sum((p) => p.late)}</strong><em>after ${E.fmtTime(E.clockToMin(b.settings.workStart) + b.settings.graceMin)}</em></button>
        <button type="button" class="stat link-stat" data-go="punctuality"><span>Absences</span><strong>${sum((p) => p.absent)}</strong><em>working days with no punches</em></button>
      </div>
      <div class="card"><div class="card-head"><h2>Hours by employee</h2></div>${table(rep, { cell: (v, j, r) => (j === 0 ? `<button type="button" class="row-btn" data-go="timecards" data-person="${esc(r[1])}">${esc(v)}</button>` : j === 3 ? `<strong>${esc(v)}</strong>` : esc(v)) })}</div>${closed}`;
  }

  function renderTimecards() {
    const b = B(), p = b.people.find((x) => x.id === state.person);
    const rows = p.days.filter((d) => !(d.status === 'off' && !d.punches.length) && d.status !== 'nodata').map((d) => {
      const pun = d.punches.map((x) => `<span class="punch ${x.kind && x.kind !== 'clock' ? x.kind : ''}"><i>${x.type === 'IN' ? 'In' : 'Out'}</i> ${E.fmtTime(x.min)}</span>`).join('');
      return `<tr class="st-${d.status}"><td class="l nowrap">${E.fmtDate(d.date)}</td><td class="l">${pun || '<span class="muted">No punches</span>'}${d.unresolved.length ? `<span class="fn warn">${esc(missing(d))}</span>` : ''}${d.note ? `<span class="fn">Note: ${esc(d.note)}</span>` : ''}</td>
        <td>${d.minutes ? `<strong>${E.fmtDur(d.minutes)}</strong>` : ''}${d.lunch ? `<span class="fn">${d.lunch} min lunch taken off</span>` : ''}</td>
        <td class="l">${statusChip(d)}${d.kinds.filter((k) => KIND[k]).map((k) => chip(KIND[k], 'how')).join('')}</td>
        <td class="no-print act">${d.status === 'partial' && !d.punches.length ? '' : `<button type="button" class="ghost-btn" data-edit="${p.id}|${d.date}">${d.status === 'attention' ? 'Fix' : 'Edit'}</button>`}</td></tr>`;
    }).join('');
    $('#tab-timecards').innerHTML = `<div class="pane-head"><div><h1>Timecards</h1><p class="lede">One person's pay period, day by day. Use Fix to add a punch the clock missed.</p></div>
        ${exportBar('person', '<button type="button" class="btn small" data-x="print" data-r="cards">Print all timecards</button>')}</div>
      <div class="people no-print" role="group" aria-label="Employee">${b.people.map((x) => `<button type="button" data-person-pick="${x.id}" aria-pressed="${x.id === p.id}">${esc(x.name)}${x.attention ? `<span class="count">${x.attention}</span>` : ''}</button>`).join('')}</div>
      <div class="card"><div class="sched-head"><div><h2>${esc(p.name)}</h2><p class="who">Employee ID ${esc(p.id)}. ${p.daysWorked} days worked${p.absent ? `, ${p.absent} absent` : ''}${p.late ? `, ${p.late} late` : ''}.</p></div>
        <div class="figure"><span>Total hours</span><strong>${E.fmtDur(p.totalMin)}</strong>${p.clockTotalMin != null && p.clockTotalMin !== p.totalMin ? `<span>clock reported ${E.fmtDur(p.clockTotalMin)}</span>` : p.clockTotalMin == null ? '<span>clock reported none</span>' : ''}</div></div>
        <div class="scroll"><table><thead><tr><th class="l">Date</th><th class="l">Punches</th><th>Hours</th><th class="l">Status</th><th class="no-print"></th></tr></thead><tbody>${rows}</tbody></table></div>
        <div class="notes">${b.shift ? '<span>Rebuilt: the clock recorded both punches but did not pair them. Assumed: two punches with the same label were read as arrival and departure. Corrected: a punch was added by hand.</span>' : ''}<span>A day marked "Partly outside the uploaded files" is missing punches that sit in an export not uploaded yet. It is counted once that file is added.</span></div></div>`;
  }
  $('#tab-timecards').addEventListener('click', (e) => { const b = e.target.closest('[data-person-pick]'); if (b) { state.person = b.dataset.personPick; renderTimecards(); } });

  function renderAttention() {
    const rep = rAttention();
    $('#tab-attention').innerHTML = `<div class="pane-head"><div><h1>Needs attention</h1><p class="lede">Days where a clock-in or clock-out is missing, so the hours cannot be completed. Add the missing time once you have confirmed it.</p></div>${exportBar('attention')}</div>
      <div class="card">${table(rep, { empty: 'Every day in this pay period is complete.', action: (r) => `<button type="button" class="ghost-btn" data-edit="${esc(r[7])}|${r[1]}">Fix</button>` })}</div>`;
  }
  function renderPunctuality() {
    const rep = rPunctuality(), cls = { 'Late arrival': 'attention', 'Left early': 'how', Absent: 'absent', 'Weekend work': 'ok' };
    $('#tab-punctuality').innerHTML = `<div class="pane-head"><div><h1>Punctuality and absence</h1><p class="lede">${esc(rep.sub)}</p></div>${exportBar('punctuality')}</div>
      <div class="card">${table(rep, { empty: 'No late arrivals, early departures or absences in this pay period.', cell: (v, j) => (j === 3 ? chip(v, cls[v]) : j === 1 ? esc(E.fmtDate(v).slice(4)) : esc(v)) })}</div>`;
  }

  // ---------- correcting a day ----------
  const dlg = $('#dayDialog'); let editing = null;
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-edit]'); if (b) openDay(b.dataset.edit); });
  function openDay(key) {
    const [id, date] = key.split('|'); const p = B().people.find((x) => x.id === id), d = p.days.find((x) => x.date === date);
    editing = { key, add: d.manual.map((m) => ({ t: m.t, type: m.type })) };
    $('#dayTitle').textContent = `${p.name}, ${E.fmtDate(date, true)}`;
    $('#daySub').textContent = d.unresolved.length ? missing(d) + '.' : d.minutes ? `Counted as ${E.fmtDur(d.minutes)} hours.` : 'No hours counted.';
    $('#dayPunches').innerHTML = d.punches.filter((x) => x.src !== 'manual').map((x) => `<span class="punch ${x.kind && x.kind !== 'clock' ? x.kind : ''}"><i>${x.type === 'IN' ? 'In' : 'Out'}</i> ${E.fmtTime(x.min)}</span>`).join('') || '<span class="muted">The clock recorded no punches on this day.</span>';
    $('#dayNote').value = d.note; $('#addTime').value = ''; $('#addType').value = d.unresolved[0] && d.unresolved[0].type === 'IN' ? 'OUT' : 'IN'; $('#dayError').hidden = true;
    drawManual(); dlg.showModal();
  }
  function drawManual() { $('#manualList').innerHTML = editing.add.map((m, i) => `<span class="punch manual"><i>${m.type === 'IN' ? 'In' : 'Out'}</i> ${E.fmtTime(E.clockToMin(m.t))} <button type="button" data-rm="${i}" aria-label="Remove this punch">Remove</button></span>`).join(''); }
  $('#addPunch').addEventListener('click', () => { const t = $('#addTime').value; if (!t) { $('#dayError').textContent = 'Enter the time of the missing punch.'; $('#dayError').hidden = false; return; } $('#dayError').hidden = true; editing.add.push({ t, type: $('#addType').value }); $('#addTime').value = ''; drawManual(); });
  $('#manualList').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) { editing.add.splice(+b.dataset.rm, 1); drawManual(); } });
  $('#dayCancel').addEventListener('click', () => dlg.close());
  $('#dayForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('#addTime').value) editing.add.push({ t: $('#addTime').value, type: $('#addType').value });
    const r = await api('correct', { key: editing.key, add: editing.add, note: $('#dayNote').value });
    if (!r.ok) { $('#dayError').textContent = r.json.error || 'The correction could not be saved. Try again.'; $('#dayError').hidden = false; return; }
    state.corrections = r.json.corrections; dlg.close(); rebuild(); flash('Correction saved.');
  });

  // ---------- uploads ----------
  // Before saving, compare the record with and without the new file so she sees exactly what it changes.
  function preview(parsed) {
    const now = state.uploads.length ? E.merge(state.uploads) : { source: {} };
    const after = E.merge(state.uploads.concat([{ id: 'new', parsed, uploadedAt: '9999' }]));
    let added = 0, updated = 0, same = 0;
    for (const [k, v] of Object.entries(after.source)) {
      if (v.upload !== 'new') continue;
      const old = now.source[k];
      if (!old) added++; else if (JSON.stringify(old.rows) !== JSON.stringify(v.rows)) updated++; else same++;
    }
    for (const [k, v] of Object.entries(now.source)) if (after.source[k] && after.source[k].upload !== 'new' && parsed.employees.some((e) => k.startsWith(e.id + '|'))) { const d = k.split('|')[1]; if (d >= parsed.start && d <= parsed.end) same++; }
    const known = new Set((state.merged ? state.merged.employees : []).map((e) => e.id));
    const newPeople = parsed.employees.filter((e) => !known.has(e.id)).map((e) => e.name);
    return { added, updated, same, newPeople };
  }
  let pending = null;
  function readFile(file) {
    if (!file) return; const fr = new FileReader();
    fr.onload = () => {
      let parsed;
      try { parsed = E.parseCsv(fr.result); } catch (err) { pending = null; $('#preview').innerHTML = `<p class="form-error">${esc(err.message)} Export the Timecard Report from the clock again and choose that file.</p>`; return; }
      pending = { csv: fr.result, filename: file.name, parsed };
      const d = preview(parsed), nothing = !d.added && !d.updated;
      const what = nothing ? 'Everything in this file is already in the portal, so adding it changes nothing.'
        : 'This file ' + [d.added && `adds ${d.added} new ${d.added === 1 ? 'day' : 'days'} of punches`, d.updated && `fills in ${d.updated} ${d.updated === 1 ? 'day' : 'days'} that an earlier file had only partly`].filter(Boolean).join(' and ') + '.';
      $('#preview').innerHTML = `<div class="card pad"><h2>${esc(file.name)}</h2>
        <p>Covers ${esc(rangeLabel({ from: parsed.start, to: parsed.end }))} for ${parsed.employees.length} employees.${d.newPeople.length ? ` New to the portal: ${esc(d.newPeople.join(', '))}.` : ''}</p>
        <p><strong>${what}</strong>${d.same && !nothing ? ` The ${d.same} days it shares with earlier files are already here and are counted once.` : ''}</p>
        ${nothing ? '' : '<p class="muted small">Day counts are per employee. Your corrections and notes are kept.</p>'}
        <div class="row">${nothing ? '<button type="button" class="btn" id="cancelUpload">Done</button>' : '<button type="button" class="btn" id="saveUpload">Add to the record</button><button type="button" class="quiet-btn" id="cancelUpload">Cancel</button>'}</div></div>`;
    };
    fr.onerror = () => { $('#preview').innerHTML = '<p class="form-error">The file could not be read. Choose it again.</p>'; };
    fr.readAsText(file);
  }
  $('#fileInput').addEventListener('change', (e) => { readFile(e.target.files[0]); e.target.value = ''; });
  const drop = $('#drop');
  ['dragover', 'dragenter'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => readFile(e.dataTransfer.files[0]));
  $('#preview').addEventListener('click', async (e) => {
    if (e.target.id === 'cancelUpload') { pending = null; $('#preview').innerHTML = ''; return; }
    if (e.target.id !== 'saveUpload' || !pending) return;
    e.target.disabled = true; const p = pending.parsed;
    const r = await api('upload', { csv: pending.csv, filename: pending.filename, start: p.start, end: p.end, employees: p.employees.length });
    if (!r.ok) { e.target.disabled = false; return flash(r.json.error || 'The file could not be saved. Try again.', true); }
    pending = null; $('#preview').innerHTML = '';
    await loadData({ from: p.start, to: p.end }); go('overview');
    flash(r.json.duplicate ? 'That exact file was already uploaded, so nothing changed.' : 'Added. Reports now include this file.');
  });
  function renderUploads() {
    const list = state.uploads.slice().sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
    const cover = state.merged ? `<p class="muted small">Clock data on record: ${esc(rangeLabel({ from: state.merged.start, to: state.merged.end }))}.</p>` : '';
    $('#periodList').innerHTML = `<div class="card-head"><h2>Uploaded files</h2>${cover}</div>` + (list.length ? `<div class="scroll"><table><thead><tr><th class="l">File</th><th class="l">Covers</th><th>Employees</th><th class="l">Uploaded</th><th></th></tr></thead><tbody>${list.map((u) => `<tr><td class="l">${esc(u.filename)}</td><td class="l"><button type="button" class="row-btn" data-open="${u.start}|${u.end}">${esc(rangeLabel({ from: u.start, to: u.end }))}</button></td><td>${u.employees || ''}</td><td class="l">${esc(new Date(u.uploadedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }))}</td>
      <td class="act"><span class="confirm" hidden>Remove this file? Days that only it contains leave the reports; your corrections are kept. <button type="button" class="ghost-btn danger" data-del="${u.id}">Remove</button> <button type="button" class="quiet-btn" data-keep>Keep</button></span><button type="button" class="quiet-btn" data-ask>Remove</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">Nothing uploaded yet.</p>');
  }
  $('#periodList').addEventListener('click', async (e) => {
    const t = e.target, cell = t.closest('td');
    if (t.dataset.open) { const [from, to] = t.dataset.open.split('|'); state.range = { from, to }; drawRangePicker(); rebuild(); go('overview'); }
    else if ('ask' in t.dataset) { cell.querySelector('.confirm').hidden = false; t.hidden = true; }
    else if ('keep' in t.dataset) { cell.querySelector('.confirm').hidden = true; cell.querySelector('[data-ask]').hidden = false; }
    else if (t.dataset.del) { const r = await api('delete', { id: t.dataset.del }); if (r.ok) { state.range = null; await loadData(); flash('File removed.'); } }
  });

  // ---------- settings ----------
  function fillSettings() {
    const s = settingsFor(state.merged);
    $('#setStart').value = s.workStart; $('#setEnd').value = s.workEnd; $('#setGrace').value = s.graceMin; $('#setLunch').value = s.lunchMin;
    $('#setCutoff').value = s.cutoff || ''; $('#setAssume').checked = !!s.assumeSameLabel; $('#setHolidays').value = (s.holidays || []).join('\n');
  }
  $('#settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const days = $('#setHolidays').value.split(/[\s,]+/).filter(Boolean), bad = days.filter((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d));
    if (bad.length) { $('#settingsMsg').textContent = `Write closed dates as year-month-day, for example 2026-12-25. Check: ${bad.join(', ')}`; return; }
    const r = await api('settings', { workStart: $('#setStart').value, workEnd: $('#setEnd').value, graceMin: +$('#setGrace').value, lunchMin: +$('#setLunch').value, cutoff: $('#setCutoff').value, assumeSameLabel: $('#setAssume').checked, holidays: days });
    if (!r.ok) { $('#settingsMsg').textContent = r.json.error || 'The settings could not be saved.'; return; }
    state.saved = r.json.settings; $('#settingsMsg').textContent = 'Saved. Reports now use these settings.'; rebuild();
  });

  start();
})();
