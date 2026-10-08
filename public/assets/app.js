/* HR Timecards front end: sign-in, uploads, reports, corrections and exports. No build step. */
(function () {
  'use strict';
  const E = window.Engine;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const STATUS = { ok: 'Complete', attention: 'Needs attention', absent: 'Absent', off: 'Weekend', closed: 'Office closed', holiday: 'Holiday', partial: 'Outside this export' };
  const KIND = { recovered: 'Rebuilt', assumed: 'Assumed', manual: 'Corrected' };

  const state = { periods: [], saved: null, period: null, parsed: null, built: null, tab: 'overview', person: null };

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
    await loadPeriods();
  }
  $('#loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault(); const b = $('#loginBtn'); b.disabled = true;
    const r = await api('login', { password: $('#password').value }); b.disabled = false;
    if (r.ok) { $('#password').value = ''; start(); } else showLogin(r.json.error || 'Sign-in failed. Try again.');
  });
  $('#logoutBtn').addEventListener('click', async () => { await api('logout', {}); state.period = state.built = null; showLogin(''); });

  // ---------- data ----------
  const periodLabel = (p) => `${E.fmtDate(p.start).slice(4)} to ${E.fmtDate(p.end, true).slice(4)}`;
  function settingsFor(parsed) {
    if (state.saved && !Array.isArray(state.saved) && state.saved.workStart) return Object.assign({}, E.DEFAULTS, state.saved);
    return Object.assign({}, E.DEFAULTS, { cutoff: E.detectSplitDays(parsed) ? '16:30' : '' });
  }
  async function loadPeriods(selectId) {
    const r = await api('periods'); if (!r.ok) return;
    state.periods = r.json.periods || []; state.saved = r.json.settings;
    const sel = $('#periodSel');
    sel.innerHTML = state.periods.map((p) => `<option value="${p.id}">${esc(periodLabel(p))}</option>`).join('') || '<option value="">No pay period yet</option>';
    sel.disabled = !state.periods.length;
    renderPeriodList(); fillSettings();
    const id = selectId || (state.period && state.periods.some((p) => p.id === state.period.id) ? state.period.id : state.periods[0] && state.periods[0].id);
    if (id) { sel.value = id; await loadPeriod(id); } else { state.period = state.built = null; renderAll(); go('uploads'); }
  }
  async function loadPeriod(id) {
    const r = await api('period', undefined, 'id=' + encodeURIComponent(id));
    if (!r.ok || r.json.error) return flash('That pay period could not be opened.', true);
    state.period = r.json;
    try { state.parsed = E.parseCsv(r.json.csv); } catch (e) { return flash(e.message, true); }
    rebuild();
  }
  function rebuild() {
    const c = state.period.corrections; state.settings = settingsFor(state.parsed);
    state.built = E.build(state.parsed, state.settings, Array.isArray(c) ? {} : c || {});
    if (!state.person || !state.built.people.some((p) => p.id === state.person)) state.person = state.built.people[0].id;
    renderAll();
  }
  $('#periodSel').addEventListener('change', (e) => { if (e.target.value) loadPeriod(e.target.value); });

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
  const span = () => periodLabel(B());
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
      if (d.status === 'off' && !d.punches.length) continue;
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
    const has = !!B();
    for (const t of ['overview', 'timecards', 'attention', 'punctuality']) if (!has) $('#tab-' + t).innerHTML = `<div class="pane-head"><div><h1>No pay period yet</h1><p class="lede">Upload the time clock's export to see reports here.</p></div></div><button type="button" class="btn" data-go="uploads">Go to uploads</button>`;
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
      <p>The clock is set to start a new day at ${E.fmtTime(E.clockToMin(b.settings.cutoff))} instead of midnight, so it filed each morning clock-in under the day before and could not match it to that evening's clock-out. It reported ${E.fmtDur(clock)} hours in total. Put back together day by day, the same punches come to ${E.fmtDur(total)} hours.</p>
      <p>Every figure the portal rebuilt is marked, and both totals appear in the table below so you can compare. <button type="button" class="link" data-go="settings">Review how the file is read</button></p></div>` : '';
    const closed = b.closed.length ? `<p class="muted small">Treated as office closed (nobody clocked in): ${b.closed.map((d) => E.fmtDate(d)).join(', ')}.</p>` : '';
    $('#tab-overview').innerHTML = `<div class="pane-head"><div><h1>Pay period ${esc(span())}</h1>
        <p class="lede">${b.people.length} employees. Uploaded file: ${esc(state.period.filename)}.</p></div>
        ${exportBar('summary', '<button type="button" class="btn small" data-x="xlsx" data-r="all">Download all reports (Excel)</button>')}</div>
      ${split}
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
    const rows = p.days.filter((d) => !(d.status === 'off' && !d.punches.length)).map((d) => {
      const pun = d.punches.map((x) => `<span class="punch ${x.kind && x.kind !== 'clock' ? x.kind : ''}"><i>${x.type === 'IN' ? 'In' : 'Out'}</i> ${E.fmtTime(x.min)}</span>`).join('');
      return `<tr class="st-${d.status}"><td class="l nowrap">${E.fmtDate(d.date)}</td><td class="l">${pun || '<span class="muted">No punches</span>'}${d.unresolved.length ? `<span class="fn warn">${esc(missing(d))}</span>` : ''}${d.note ? `<span class="fn">Note: ${esc(d.note)}</span>` : ''}</td>
        <td>${d.minutes ? `<strong>${E.fmtDur(d.minutes)}</strong>` : ''}${d.lunch ? `<span class="fn">${d.lunch} min lunch taken off</span>` : ''}</td>
        <td class="l">${statusChip(d)}${d.kinds.filter((k) => KIND[k]).map((k) => chip(KIND[k], 'how')).join('')}</td>
        <td class="no-print act">${d.status === 'partial' ? '' : `<button type="button" class="ghost-btn" data-edit="${p.id}|${d.date}">${d.status === 'attention' ? 'Fix' : 'Edit'}</button>`}</td></tr>`;
    }).join('');
    $('#tab-timecards').innerHTML = `<div class="pane-head"><div><h1>Timecards</h1><p class="lede">One person's pay period, day by day. Use Fix to add a punch the clock missed.</p></div>
        ${exportBar('person', '<button type="button" class="btn small" data-x="print" data-r="cards">Print all timecards</button>')}</div>
      <div class="people no-print" role="group" aria-label="Employee">${b.people.map((x) => `<button type="button" data-person-pick="${x.id}" aria-pressed="${x.id === p.id}">${esc(x.name)}${x.attention ? `<span class="count">${x.attention}</span>` : ''}</button>`).join('')}</div>
      <div class="card"><div class="sched-head"><div><h2>${esc(p.name)}</h2><p class="who">Employee ID ${esc(p.id)}. ${p.daysWorked} days worked${p.absent ? `, ${p.absent} absent` : ''}${p.late ? `, ${p.late} late` : ''}.</p></div>
        <div class="figure"><span>Total hours</span><strong>${E.fmtDur(p.totalMin)}</strong>${p.clockTotalMin != null && p.clockTotalMin !== p.totalMin ? `<span>clock reported ${E.fmtDur(p.clockTotalMin)}</span>` : p.clockTotalMin == null ? '<span>clock reported none</span>' : ''}</div></div>
        <div class="scroll"><table><thead><tr><th class="l">Date</th><th class="l">Punches</th><th>Hours</th><th class="l">Status</th><th class="no-print"></th></tr></thead><tbody>${rows}</tbody></table></div>
        <div class="notes">${b.shift ? '<span>Rebuilt: the clock recorded both punches but did not pair them. Assumed: two punches with the same label were read as arrival and departure. Corrected: a punch was added by hand.</span>' : ''}<span>Punches on the first and last days fall partly outside this export and are not counted.</span></div></div>`;
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
    const r = await api('correct', { id: state.period.id, key: editing.key, add: editing.add, note: $('#dayNote').value });
    if (!r.ok) { $('#dayError').textContent = r.json.error || 'The correction could not be saved. Try again.'; $('#dayError').hidden = false; return; }
    state.period.corrections = r.json.corrections; dlg.close(); rebuild(); flash('Correction saved.');
  });

  // ---------- uploads ----------
  let pending = null;
  function readFile(file) {
    if (!file) return; const fr = new FileReader();
    fr.onload = () => {
      try { const parsed = E.parseCsv(fr.result); pending = { csv: fr.result, filename: file.name, parsed }; }
      catch (err) { pending = null; $('#preview').innerHTML = `<p class="form-error">${esc(err.message)}</p>`; return; }
      const p = pending.parsed, exists = state.periods.some((x) => x.start === p.start && x.end === p.end);
      $('#preview').innerHTML = `<div class="card pad"><h2>${esc(file.name)}</h2>
        <p>Pay period ${esc(periodLabel(p))}, ${p.employees.length} employees: ${esc(p.employees.map((x) => x.name).join(', '))}.</p>
        ${E.detectSplitDays(p) ? '<p class="muted">This export has working days split across two report days. The portal will put them back together.</p>' : ''}
        ${exists ? '<p class="caution">A report for this pay period is already saved. Saving again replaces the file and keeps the corrections you have made.</p>' : ''}
        <div class="row"><button type="button" class="btn" id="saveUpload">${exists ? 'Replace the saved report' : 'Save this pay period'}</button><button type="button" class="quiet-btn" id="cancelUpload">Cancel</button></div></div>`;
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
    const r = await api('upload', { csv: pending.csv, filename: pending.filename, start: p.start, end: p.end, employees: p.employees.length, replace: true, keepCorrections: true });
    if (!r.ok) { e.target.disabled = false; return flash(r.json.error || 'The file could not be saved. Try again.', true); }
    pending = null; $('#preview').innerHTML = ''; await loadPeriods(r.json.id); go('overview'); flash('Pay period saved.');
  });
  function renderPeriodList() {
    $('#periodList').innerHTML = `<div class="card-head"><h2>Saved pay periods</h2></div>` + (state.periods.length ? `<div class="scroll"><table><thead><tr><th class="l">Pay period</th><th class="l">File</th><th>Employees</th><th class="l">Uploaded</th><th></th></tr></thead><tbody>${state.periods.map((p) => `<tr><td class="l"><button type="button" class="row-btn" data-open="${p.id}">${esc(periodLabel(p))}</button></td><td class="l">${esc(p.filename)}</td><td>${p.employees || ''}</td><td class="l">${esc(new Date(p.uploadedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }))}</td>
      <td class="act"><span class="confirm" hidden>Delete this pay period and its corrections? <button type="button" class="ghost-btn danger" data-del="${p.id}">Delete</button> <button type="button" class="quiet-btn" data-keep>Keep</button></span><button type="button" class="quiet-btn" data-ask>Delete</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">Nothing uploaded yet.</p>');
  }
  $('#periodList').addEventListener('click', async (e) => {
    const t = e.target, cell = t.closest('td');
    if (t.dataset.open) { $('#periodSel').value = t.dataset.open; await loadPeriod(t.dataset.open); go('overview'); }
    else if ('ask' in t.dataset) { cell.querySelector('.confirm').hidden = false; t.hidden = true; }
    else if ('keep' in t.dataset) { cell.querySelector('.confirm').hidden = true; cell.querySelector('[data-ask]').hidden = false; }
    else if (t.dataset.del) { const r = await api('delete', { id: t.dataset.del }); if (r.ok) { await loadPeriods(); flash('Pay period deleted.'); } }
  });

  // ---------- settings ----------
  function fillSettings() {
    const s = state.saved && !Array.isArray(state.saved) && state.saved.workStart ? Object.assign({}, E.DEFAULTS, state.saved) : (state.parsed ? settingsFor(state.parsed) : E.DEFAULTS);
    $('#setStart').value = s.workStart; $('#setEnd').value = s.workEnd; $('#setGrace').value = s.graceMin; $('#setLunch').value = s.lunchMin;
    $('#setCutoff').value = s.cutoff || ''; $('#setAssume').checked = !!s.assumeSameLabel; $('#setHolidays').value = (s.holidays || []).join('\n');
  }
  $('#settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const days = $('#setHolidays').value.split(/[\s,]+/).filter(Boolean), bad = days.filter((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d));
    if (bad.length) { $('#settingsMsg').textContent = `Write closed dates as year-month-day, for example 2026-12-25. Check: ${bad.join(', ')}`; return; }
    const r = await api('settings', { workStart: $('#setStart').value, workEnd: $('#setEnd').value, graceMin: +$('#setGrace').value, lunchMin: +$('#setLunch').value, cutoff: $('#setCutoff').value, assumeSameLabel: $('#setAssume').checked, holidays: days });
    if (!r.ok) { $('#settingsMsg').textContent = r.json.error || 'The settings could not be saved.'; return; }
    state.saved = r.json.settings; $('#settingsMsg').textContent = 'Saved. Reports now use these settings.'; if (state.period) rebuild();
  });

  start();
})();
