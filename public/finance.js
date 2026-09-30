(function () {
  const cfg = window.APP_CONFIG;
  const { createClient } = window.supabase;
  const db = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const PLATFORM_LABELS = { airbnb: 'Airbnb', vrbo: 'VRBO', booking: 'Booking.com', direct: 'Direct booking' };
  const TAX_PLATFORMS = ['airbnb', 'vrbo', 'booking', 'direct'];
  // Stessa categories that aren't operating expenses.
  const NOT_OPEX = new Set(['Income', 'Transfers', 'Mortgages & Loans', 'Capital Expenses']);
  // Recurring bills checked month by month on the Import tab.
  const BILLS = [
    { label: 'Mortgage', test: (t) => t.category === 'Mortgages & Loans' },
    { label: 'HOA', test: (t) => /hoa/i.test(t.sub_category || '') },
    { label: 'Electric', test: (t) => /electric/i.test(t.sub_category || '') },
    { label: 'Gas', test: (t) => /^gas$/i.test(t.sub_category || '') },
    { label: 'Water & Sewer', test: (t) => /water/i.test(t.sub_category || '') },
    { label: 'Internet / TV', test: (t) => /telephone|cable|internet/i.test(t.sub_category || '') },
    { label: 'PriceLabs', test: (t) => /pricelabs/i.test(t.description) },
  ];
  // Common spellings in the old workbook, so hours add up per person.
  const NAME_FIXES = { campell: 'Campbell', setphanie: 'Stephanie', stephance: 'Stephanie' };
  // First names that sometimes appear together without a comma ("Stephanie Campbell").
  const REGULARS = ['kyle', 'stephanie', 'campbell'];

  let transactions = [];
  let activity = [];
  let bookings = [];
  let settings = {};
  let year = new Date().getFullYear();
  let editingId = null;
  let chart = null;
  let pendingImport = null;

  // ---------- Helpers ----------

  // Small DOM builder. Text always goes through textContent - descriptions
  // come from bank data and must never be treated as HTML.
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'style') node.style.cssText = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    });
    children.flat().forEach((c) => {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return node;
  }

  const money = (n, cents = false) => {
    if (n === null || n === undefined || Number.isNaN(n)) return '-';
    const s = Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
    return (n < 0 ? '-$' : '$') + s;
  };
  const cell = (n) => (Math.abs(n) < 0.5 ? el('td', { class: 'muted' }, '-') : el('td', { class: n < 0 ? 'neg' : '' }, money(n)));
  const monthOf = (iso) => Number(iso.slice(5, 7)) - 1;
  const yearOf = (iso) => Number(iso.slice(0, 4));
  const round2 = (n) => Math.round(n * 100) / 100;
  const todayIso = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const dayLabel = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };
  const mileageRate = (y) => {
    const r = (settings.mileage_rate || {})[String(y)];
    return typeof r === 'number' ? r : null;
  };

  function people(attendees) {
    return (attendees || '')
      .split(/,|\/|\band\b|&/i)
      .map((s) => s.replace(/\(.*?\)/g, '').trim())
      .filter((s) => s && !/^n\/?a$/i.test(s))
      .flatMap((s) => {
        const words = s.split(/\s+/);
        const known = (w) => REGULARS.includes((NAME_FIXES[w.toLowerCase()] || w).toLowerCase());
        return words.length > 1 && words.every(known) ? words : [s];
      })
      .map((s) => NAME_FIXES[s.toLowerCase()] || s.replace(/\b\w/g, (c) => c.toUpperCase()));
  }

  // Supabase returns at most 1000 rows per request, so page through.
  async function fetchAll(table, select, order) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from(table).select(select).order(order).range(from, from + 999);
      if (error) throw error;
      out.push(...data);
      if (data.length < 1000) return out;
    }
  }

  // ---------- Data ----------

  async function loadAll() {
    const status = document.getElementById('dataStatus');
    try {
      const [tx, act, set, bk] = await Promise.all([
        fetchAll('fin_transactions', '*', 'date'),
        fetchAll('fin_activity', '*', 'date'),
        db.from('fin_settings').select('*'),
        db.from('bookings').select('uid, source, start_date, end_date, assigned_cleaner, cancelled').eq('cancelled', false),
      ]);
      if (set.error) throw set.error;
      transactions = tx;
      activity = act;
      settings = Object.fromEntries(set.data.map((r) => [r.key, r.value]));
      bookings = bk.data || [];
    } catch (err) {
      console.error(err);
      status.textContent = /fin_/.test(err.message || '') || err.code === 'PGRST205'
        ? 'Finance tables are not set up yet - run supabase/finance.sql in Supabase.'
        : 'Could not load finance data - see console.';
      return;
    }

    const latest = transactions.reduce((m, t) => (t.date > m ? t.date : m), '');
    const lastImport = transactions.reduce((m, t) => (t.imported_at > m ? t.imported_at : m), '');
    status.textContent = transactions.length
      ? `${transactions.length} transactions through ${dayLabel(latest)} · last import ${new Date(lastImport).toLocaleDateString()}`
      : 'No transactions yet - import a Stessa CSV on the Import tab.';

    renderYearOptions();
    renderAll();
  }

  function renderYearOptions() {
    const years = new Set([new Date().getFullYear()]);
    transactions.forEach((t) => years.add(yearOf(t.date)));
    activity.forEach((a) => years.add(yearOf(a.date)));
    const sel = document.getElementById('yearSelect');
    sel.replaceChildren(...[...years].sort((a, b) => b - a).map((y) => el('option', { value: y }, y)));
    sel.value = String(year);
  }

  function renderAll() {
    document.querySelectorAll('.yearLabel').forEach((n) => (n.textContent = year));
    renderOverview();
    renderActivity();
    renderTaxes();
    renderBills();
  }

  // ---------- Overview: KPIs, chart, P&L ----------

  const yearTx = () => transactions.filter((t) => !t.excluded && yearOf(t.date) === year && t.category !== 'Transfers');
  const yearActivity = () => activity.filter((a) => !a.excluded && yearOf(a.date) === year);

  function byMonth(rows, pick = (t) => t.amount) {
    const m = Array(12).fill(0);
    rows.forEach((t) => (m[monthOf(t.date)] += Number(pick(t))));
    return m;
  }
  const sum = (arr) => arr.reduce((s, n) => s + n, 0);

  function renderOverview() {
    const tx = yearTx();
    const income = tx.filter((t) => t.category === 'Income');
    const opex = tx.filter((t) => !NOT_OPEX.has(t.category));
    const mortgage = tx.filter((t) => t.category === 'Mortgages & Loans');
    const capex = tx.filter((t) => t.category === 'Capital Expenses');
    const acts = yearActivity();
    const miles = sum(acts.map((a) => Number(a.miles)));
    const hours = sum(acts.map((a) => Number(a.hours)));
    const rate = mileageRate(year);

    const incomeM = byMonth(income);
    const opexM = byMonth(opex);
    const mortM = byMonth(mortgage);
    const capexM = byMonth(capex);
    const netM = incomeM.map((v, i) => v + opexM[i] + mortM[i] + capexM[i]);

    const kpi = (label, value, sub, tone) =>
      el('div', { class: 'kpi' }, el('div', { class: 'stat-label' }, label), el('div', { class: `stat-value ${tone || ''}` }, value), sub ? el('div', { class: 'stat-sub' }, sub) : null);
    document.getElementById('kpis').replaceChildren(
      kpi('Rental income', money(sum(incomeM)), `${year} to date`),
      kpi('Operating expenses', money(-sum(opexM)), 'utilities, cleaning, HOA, supplies…'),
      kpi('Mortgage', money(-sum(mortM)), 'principal + interest'),
      kpi('Net cash flow', money(sum(netM)), 'income - all of the above', sum(netM) >= 0 ? 'good' : 'bad'),
      kpi('Miles logged', Math.round(miles).toLocaleString(), rate ? `≈ ${money(miles * rate)} deduction at $${rate}/mi` : 'set the mileage rate on the Taxes tab'),
      kpi('Hours logged', round2(hours).toLocaleString(), 'material participation log')
    );

    renderChart(incomeM, opexM.map((v, i) => v + mortM[i] + capexM[i]), netM);
    renderPl(tx, { incomeM, opexM, mortM, capexM, netM }, acts, rate);
  }

  function renderChart(incomeM, costM, netM) {
    if (chart) chart.destroy();
    chart = new Chart(document.getElementById('cashChart'), {
      data: {
        labels: MONTHS,
        datasets: [
          { type: 'bar', label: 'Income', data: incomeM.map(round2), backgroundColor: '#2e9e5b' },
          { type: 'bar', label: 'Expenses incl. mortgage', data: costM.map((v) => round2(-v)), backgroundColor: '#e5484d' },
          { type: 'line', label: 'Net cash flow', data: netM.map(round2), borderColor: '#1f6feb', backgroundColor: '#1f6feb', tension: 0.2 },
        ],
      },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: { y: { ticks: { callback: (v) => money(v) } } },
        plugins: {
          legend: { position: 'bottom' },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${money(c.parsed.y)}` } },
        },
      },
    });
  }

  function renderPl(tx, t, acts, rate) {
    const table = document.getElementById('plTable');
    const head = el('thead', null, el('tr', null, el('th', null, String(year)), MONTHS.map((m) => el('th', null, m)), el('th', null, 'Total')));
    const rows = [];
    const row = (label, values, cls) => rows.push(el('tr', { class: cls || '' }, el('td', null, label), values.map(cell), cell(sum(values))));
    const section = (label) => rows.push(el('tr', { class: 'section' }, el('td', { colspan: 14 }, label)));

    section('Income');
    const income = tx.filter((x) => x.category === 'Income');
    ['airbnb', 'vrbo', 'booking', 'direct'].forEach((p) => {
      const m = byMonth(income.filter((x) => x.platform === p));
      if (sum(m)) row(PLATFORM_LABELS[p], m, 'sub');
    });
    const other = byMonth(income.filter((x) => !x.platform));
    if (sum(other)) row('Other income', other, 'sub');
    row('Total income', t.incomeM, 'total');

    section('Operating expenses');
    const opex = tx.filter((x) => !NOT_OPEX.has(x.category));
    const cats = [...new Set(opex.map((x) => x.category || 'Uncategorized'))].sort();
    cats.forEach((c) => {
      const inCat = opex.filter((x) => (x.category || 'Uncategorized') === c);
      const subs = [...new Set(inCat.map((x) => x.sub_category || c))].sort();
      subs.forEach((s) => row(s === c ? c : `${c} · ${s}`, byMonth(inCat.filter((x) => (x.sub_category || c) === s)), 'sub'));
    });
    row('Total operating expenses', t.opexM, 'total');

    section('Debt service & capital');
    row('Mortgage & loans', t.mortM, 'sub');
    if (sum(t.capexM)) row('Capital expenses', t.capexM, 'sub');

    row('Net cash flow', t.netM, 'total');

    if (rate) {
      const milesM = byMonth(acts, (a) => a.miles);
      rows.push(el('tr', { class: 'note' }, el('td', null, `Mileage deduction (estimate, not cash) @ $${rate}/mi`),
        milesM.map((m) => el('td', null, m ? money(m * rate) : '-')), el('td', null, money(sum(milesM) * rate))));
    }
    table.replaceChildren(head, el('tbody', null, rows));
  }

  // ---------- Activity log ----------

  function cleaningSuggestions() {
    const today = todayIso();
    const trip = settings.cleaning_trip || { miles: 55, hours: 3 };
    const logged = new Set(activity.filter((a) => a.booking_uid).map((a) => a.booking_uid));
    const cleaningDays = new Set(activity.filter((a) => !a.excluded && /clean/i.test(`${a.description} ${a.purpose || ''}`)).map((a) => a.date));
    return bookings
      .filter((b) => yearOf(b.end_date) === year && b.end_date <= today)
      .filter((b) => b.assigned_cleaner === 'kyle_stephanie' || !b.assigned_cleaner)
      .filter((b) => !logged.has(b.uid) && !cleaningDays.has(b.end_date))
      .sort((a, b) => (a.end_date < b.end_date ? 1 : -1))
      .map((b) => ({ booking: b, trip }));
  }

  function renderActivity() {
    // Suggestions from the cleaning calendar.
    const sugg = cleaningSuggestions();
    const box = document.getElementById('suggestions');
    box.replaceChildren(
      ...(sugg.length
        ? sugg.map(({ booking: b, trip }) => el('div', { class: 'suggestion' },
          el('strong', null, dayLabel(b.end_date)),
          el('span', null, `Checkout (${PLATFORM_LABELS[b.source] || b.source}) - ${b.assigned_cleaner ? 'Kyle & Stephanie' : 'no cleaner assigned'}`),
          el('span', { class: 'muted' }, `${trip.miles} mi · ${trip.hours} hrs`),
          el('button', { class: 'btn btn-primary', type: 'button', onclick: () => addFromBooking(b, trip) }, 'Add'),
          el('button', { class: 'btn btn-secondary', type: 'button', onclick: () => fillFormFromBooking(b, trip) }, 'Edit first'),
          el('button', { class: 'btn btn-secondary', type: 'button', onclick: () => dismissBooking(b) }, 'Not us')))
        : [el('p', { class: 'muted', style: 'margin:0' }, `Nothing to add - every ${year} checkout you cleaned is in the log.`)])
    );

    // Totals.
    const acts = yearActivity();
    const miles = sum(acts.map((a) => Number(a.miles)));
    const hours = sum(acts.map((a) => Number(a.hours)));
    const rate = mileageRate(year);
    const perPerson = {};
    acts.forEach((a) => people(a.attendees).forEach((p) => (perPerson[p] = (perPerson[p] || 0) + Number(a.hours))));
    const stat = (label, value, sub) => el('div', { class: 'stat' }, el('div', { class: 'stat-label' }, label), el('div', { class: 'stat-value' }, value), sub ? el('div', { class: 'stat-sub' }, sub) : null);
    document.getElementById('activityTotals').replaceChildren(
      stat('Miles', Math.round(miles).toLocaleString(), rate ? `≈ ${money(miles * rate)} at $${rate}/mi` : 'no mileage rate set'),
      stat('Hours (all entries)', round2(hours).toLocaleString(), `${acts.length} entries`),
      ...Object.entries(perPerson).filter(([, h]) => h > 0).sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([p, h]) => stat(`${p}'s hours`, round2(h).toLocaleString(), 'entries they attended'))
    );

    // Table.
    const rows = [...acts].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    document.getElementById('activityTable').replaceChildren(
      el('thead', null, el('tr', null, ['Date', 'Description', 'Who', 'Purpose', 'Location / vendor', 'Miles', 'Hours', 'Amount', 'Notes', ''].map((h) => el('th', null, h)))),
      el('tbody', null, rows.length
        ? rows.map((a) => el('tr', null,
          el('td', { class: 'nowrap' }, dayLabel(a.date)),
          el('td', null, a.description),
          el('td', null, a.attendees || ''),
          el('td', null, a.purpose || ''),
          el('td', null, a.vendor || ''),
          el('td', null, Number(a.miles) ? String(Number(a.miles)) : ''),
          el('td', null, Number(a.hours) ? String(Number(a.hours)) : ''),
          el('td', null, a.amount !== null ? money(Number(a.amount), true) : ''),
          el('td', { class: 'muted' }, a.notes || ''),
          el('td', { class: 'row-actions' },
            el('button', { class: 'btn btn-secondary', type: 'button', onclick: () => startEdit(a) }, 'Edit'),
            el('button', { class: 'btn btn-warning', type: 'button', onclick: () => removeActivity(a) }, 'Remove'))))
        : el('tr', null, el('td', { colspan: 10, class: 'muted' }, `No entries for ${year} yet.`)))
    );
  }

  function bookingEntry(b, trip) {
    return {
      date: b.end_date,
      description: 'Home Cleaning',
      attendees: 'Kyle, Stephanie',
      purpose: 'Cleaning After Guests',
      vendor: '1143 Autumn Star Point',
      miles: trip.miles,
      hours: trip.hours,
      source: 'calendar',
      booking_uid: b.uid,
    };
  }

  async function addFromBooking(b, trip) {
    const { error } = await db.from('fin_activity').insert(bookingEntry(b, trip));
    if (error) return alertError(error);
    await reloadActivity();
  }

  // Remembers "we didn't clean this one" so the suggestion doesn't come back.
  async function dismissBooking(b) {
    const { error } = await db.from('fin_activity').insert({ ...bookingEntry(b, { miles: 0, hours: 0 }), description: 'Not cleaned by us', excluded: true });
    if (error) return alertError(error);
    await reloadActivity();
  }

  function fillFormFromBooking(b, trip) {
    const e = bookingEntry(b, trip);
    startEdit({ ...e, id: null });
    pendingBookingUid = b.uid;
  }

  let pendingBookingUid = null;

  const form = {
    date: document.getElementById('aDate'),
    description: document.getElementById('aDescription'),
    attendees: document.getElementById('aAttendees'),
    purpose: document.getElementById('aPurpose'),
    vendor: document.getElementById('aVendor'),
    miles: document.getElementById('aMiles'),
    hours: document.getElementById('aHours'),
    amount: document.getElementById('aAmount'),
    notes: document.getElementById('aNotes'),
  };

  function startEdit(a) {
    editingId = a.id || null;
    pendingBookingUid = null;
    Object.entries(form).forEach(([k, input]) => (input.value = a[k] === null || a[k] === undefined ? '' : a[k]));
    document.getElementById('activityFormTitle').textContent = editingId ? 'Edit entry' : 'Add an entry';
    document.getElementById('aSave').textContent = editingId ? 'Save changes' : 'Add entry';
    document.getElementById('aCancel').classList.toggle('hidden', !editingId);
    document.getElementById('aStatus').textContent = '';
    document.getElementById('activityForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function resetForm() {
    startEdit({ date: todayIso() });
    editingId = null;
    document.getElementById('aCancel').classList.add('hidden');
  }

  document.getElementById('aCancel').addEventListener('click', resetForm);

  document.getElementById('aSave').addEventListener('click', async () => {
    const status = document.getElementById('aStatus');
    if (!form.date.value || !form.description.value.trim()) {
      status.textContent = 'Date and description are required';
      return;
    }
    const num = (v) => (v === '' ? null : Number(v));
    const row = {
      date: form.date.value,
      description: form.description.value.trim(),
      attendees: form.attendees.value.trim() || null,
      purpose: form.purpose.value.trim() || null,
      vendor: form.vendor.value.trim() || null,
      miles: num(form.miles.value) ?? 0,
      hours: num(form.hours.value) ?? 0,
      amount: num(form.amount.value),
      notes: form.notes.value.trim() || null,
    };
    status.textContent = 'Saving...';
    const { error } = editingId
      ? await db.from('fin_activity').update(row).eq('id', editingId)
      : await db.from('fin_activity').insert({ ...row, source: pendingBookingUid ? 'calendar' : 'manual', booking_uid: pendingBookingUid });
    if (error) {
      console.error(error);
      status.textContent = 'Save failed - see console';
      return;
    }
    status.textContent = editingId ? 'Saved' : 'Added';
    resetForm();
    await reloadActivity();
  });

  async function removeActivity(a) {
    if (!confirm(`Remove "${a.description}" on ${dayLabel(a.date)} from the log?`)) return;
    const { error } = await db.from('fin_activity').update({ excluded: true }).eq('id', a.id);
    if (error) return alertError(error);
    await reloadActivity();
  }

  async function reloadActivity() {
    activity = await fetchAll('fin_activity', '*', 'date');
    renderAll();
  }

  function alertError(error) {
    console.error(error);
    alert('That did not save - see the browser console for details.');
  }

  // ---------- Taxes ----------

  function renderTaxes() {
    const taxes = settings.occupancy_tax || [];
    const income = transactions.filter((t) => !t.excluded && t.category === 'Income' && yearOf(t.date) === year);
    const box = document.getElementById('taxQuarters');
    box.replaceChildren(...[0, 1, 2, 3].map((q) => {
      const inQ = income.filter((t) => Math.floor(monthOf(t.date) / 3) === q);
      const rev = Object.fromEntries(TAX_PLATFORMS.map((p) => [p, sum(inQ.filter((t) => t.platform === p).map((t) => Number(t.amount)))]));
      const platforms = TAX_PLATFORMS.filter((p) => p !== 'direct' || rev.direct);
      const total = sum(platforms.map((p) => rev[p]));
      const totalRate = sum(taxes.map((x) => x.rate));
      // The Total column taxes the combined revenue (as filed), rather than
      // adding up the rounded per-platform amounts.
      const line = (label, rate, values, cls) => el('tr', { class: cls || '' },
        el('td', null, label), el('td', null, rate === null ? '' : `${round2(rate * 100)}%`),
        values.map((v) => el('td', null, money(v, true))),
        el('td', null, money(rate === null ? sum(values) : round2(total * rate), true)));
      return el('div', { style: 'margin-bottom:18px' },
        el('h4', { style: 'margin:0 0 6px' }, `Q${q + 1} ${year}`),
        el('div', { class: 'table-scroll' }, el('table', { class: 'comp-table pl-table' },
          el('thead', null, el('tr', null, el('th', null, ''), el('th', null, 'Rate'), platforms.map((p) => el('th', null, PLATFORM_LABELS[p])), el('th', null, 'Total'))),
          el('tbody', null,
            line('Total revenue collected', null, platforms.map((p) => rev[p]), 'section'),
            taxes.map((x) => line(x.name, x.rate, platforms.map((p) => round2(rev[p] * x.rate)))),
            line('Total tax', totalRate, platforms.map((p) => round2(rev[p] * totalRate)), 'total')))),
        total ? null : el('p', { class: 'hint' }, 'No rental income recorded for this quarter yet.'));
    }));

    // Rate inputs.
    document.getElementById('taxRates').replaceChildren(...taxes.map((x, i) => el('div', null,
      el('label', { for: `taxRate${i}` }, `${x.name} (%)`),
      el('input', { id: `taxRate${i}`, type: 'number', min: '0', step: '0.01', value: String(round2(x.rate * 100)) }))));
    const rate = mileageRate(year);
    document.getElementById('mileageRate').value = rate === null ? '' : String(rate);
  }

  document.getElementById('saveRates').addEventListener('click', async () => {
    const status = document.getElementById('ratesStatus');
    const taxes = (settings.occupancy_tax || []).map((x, i) => ({ ...x, rate: Number(document.getElementById(`taxRate${i}`).value) / 100 }));
    const mr = document.getElementById('mileageRate').value;
    const mileage = { ...(settings.mileage_rate || {}) };
    if (mr === '') delete mileage[String(year)];
    else mileage[String(year)] = Number(mr);
    status.textContent = 'Saving...';
    const { error } = await db.from('fin_settings').upsert([
      { key: 'occupancy_tax', value: taxes, updated_at: new Date().toISOString() },
      { key: 'mileage_rate', value: mileage, updated_at: new Date().toISOString() },
    ]);
    if (error) {
      console.error(error);
      status.textContent = 'Save failed - see console';
      return;
    }
    settings.occupancy_tax = taxes;
    settings.mileage_rate = mileage;
    status.textContent = 'Saved';
    renderAll();
  });

  // ---------- Bills check ----------

  function renderBills() {
    const tx = transactions.filter((t) => !t.excluded && yearOf(t.date) === year);
    const now = new Date();
    const lastMonth = year < now.getFullYear() ? 11 : year > now.getFullYear() ? -1 : now.getMonth();
    document.getElementById('billsTable').replaceChildren(
      el('thead', null, el('tr', null, el('th', null, 'Bill'), MONTHS.map((m) => el('th', null, m)))),
      el('tbody', null, BILLS.map((b) => {
        const m = byMonth(tx.filter(b.test));
        return el('tr', null, el('td', null, b.label), m.map((v, i) =>
          Math.abs(v) >= 0.5 ? el('td', null, money(-v))
            : el('td', { class: i <= lastMonth ? 'neg' : 'muted', title: i <= lastMonth ? 'Nothing found this month' : '' }, i <= lastMonth ? 'missing' : '-')));
      }))
    );
  }

  // ---------- Stessa CSV import (rules live in finance-import.js) ----------

  async function sha(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function prepareImport(text, fileName) {
    const summary = document.getElementById('importSummary');
    const btn = document.getElementById('importBtn');
    pendingImport = null;
    btn.classList.add('hidden');
    document.getElementById('importStatus').textContent = '';

    const { rows: out, skipped, missing, header } = await window.FinanceImport.prepare(text, sha);
    if (!header.length) {
      summary.textContent = 'That file is empty.';
      return;
    }
    if (missing.length) {
      summary.replaceChildren(el('div', { class: 'neg' }, `Couldn't find the ${missing.join(', ')} column(s).`),
        el('div', { class: 'muted' }, `Columns in this file: ${header.join(' | ')}`));
      return;
    }

    const existing = new Set(transactions.map((t) => t.id));
    const fresh = out.filter((t) => !existing.has(t.id));
    const dates = out.map((t) => t.date).sort();
    const uncategorized = out.filter((t) => !t.category || /uncategorized/i.test(t.category)).length;
    const accounts = [...new Set(out.map((t) => t.account).filter(Boolean))];

    summary.replaceChildren(...[
      el('div', null, el('strong', null, fileName), `: ${out.length} transactions, ${dates.length ? `${dayLabel(dates[0])} to ${dayLabel(dates[dates.length - 1])}` : ''}.`),
      el('div', null, `${fresh.length} new, ${out.length - fresh.length} already here (they'll be refreshed).`),
      accounts.length ? el('div', { class: 'muted' }, `Accounts: ${accounts.join(', ')}`) : null,
      uncategorized ? el('div', { class: 'neg' }, `${uncategorized} ${uncategorized === 1 ? 'is' : 'are'} uncategorized in Stessa - categorize them there and re-import to include them properly.`) : null,
      skipped.length ? el('div', { class: 'muted' }, `${skipped.length} rows skipped (no date, amount or description).`) : null,
    ].filter(Boolean));
    pendingImport = out;
    btn.classList.remove('hidden');
  }

  document.getElementById('importBtn').addEventListener('click', async () => {
    if (!pendingImport) return;
    const status = document.getElementById('importStatus');
    const btn = document.getElementById('importBtn');
    btn.disabled = true;
    try {
      for (let i = 0; i < pendingImport.length; i += 200) {
        status.textContent = `Importing ${Math.min(i + 200, pendingImport.length)} of ${pendingImport.length}...`;
        const { error } = await db.from('fin_transactions').upsert(pendingImport.slice(i, i + 200), { onConflict: 'id' });
        if (error) throw error;
      }
      status.textContent = `Imported ${pendingImport.length} transactions.`;
      pendingImport = null;
      btn.classList.add('hidden');
      transactions = await fetchAll('fin_transactions', '*', 'date');
      renderYearOptions();
      renderAll();
    } catch (err) {
      console.error(err);
      status.textContent = 'Import failed - see console.';
    } finally {
      btn.disabled = false;
    }
  });

  function readFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => prepareImport(String(reader.result), file.name);
    reader.readAsText(file);
  }
  document.getElementById('csvInput').addEventListener('change', (e) => readFile(e.target.files[0]));
  const zone = document.getElementById('dropZone');
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    readFile(e.dataTransfer.files[0]);
  });

  // ---------- Tabs & year ----------

  function setView(view) {
    document.querySelectorAll('.view-tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
    document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== view));
    try { localStorage.setItem('finance.view', view); } catch {}
  }
  document.querySelectorAll('.view-tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
  document.getElementById('yearSelect').addEventListener('change', (e) => {
    year = Number(e.target.value);
    renderAll();
  });

  try {
    const saved = localStorage.getItem('finance.view');
    if (saved) setView(saved);
  } catch {}
  resetForm();
  loadAll();
})();
