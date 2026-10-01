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
    // Matched on the company name too, since Stessa sometimes leaves the
    // sub-category blank (e.g. the Jan 2026 electric bill).
    { label: 'Electric', test: (t) => /electric/i.test(t.sub_category || '') || /mountain view electric/i.test(t.description) },
    { label: 'Gas', test: (t) => /^gas$/i.test(t.sub_category || '') || /black hills/i.test(t.description) },
    { label: 'Water & Sewer', test: (t) => /water/i.test(t.sub_category || '') || /woodmoor water/i.test(t.description) },
    { label: 'Internet / TV', test: (t) => /telephone|cable|internet/i.test(t.sub_category || '') || /comcast|xfinity/i.test(t.description) },
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

  // Amounts always show exact cents; only chart axis labels are whole dollars.
  const money = (n, cents = true) => {
    if (n === null || n === undefined || Number.isNaN(n)) return '-';
    // Round to the cent first so float leftovers never show as "-$0.00".
    const v = cents ? Math.round(n * 100) / 100 : Math.round(n);
    const s = Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
    return (v < 0 ? '-$' : '$') + s;
  };
  const cell = (n) => (Math.abs(n) < 0.005 ? el('td', { class: 'muted' }, '-') : el('td', { class: n < 0 ? 'neg' : '' }, money(n)));
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

  // Bills drafted at the start of the next month count toward the month they
  // cover, as in the owner's workbook (Black Hills gas paid Feb 2 = January).
  // The transaction keeps its real payment date in paid_date.
  const SERVICE_MONTH_BILLS = [/black hills/i];
  const SERVICE_MONTH_CUTOFF_DAY = 5;
  function serviceMonth(t) {
    const day = Number(t.date.slice(8, 10));
    if (day > SERVICE_MONTH_CUTOFF_DAY || !SERVICE_MONTH_BILLS.some((re) => re.test(t.description))) return t;
    const [y, m] = t.date.split('-').map(Number);
    const lastOfPrev = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
    return { ...t, paid_date: t.date, date: lastOfPrev };
  }

  // Changes made to imported transactions on this page (e.g. HOA dues
  // recategorized as a special assessment), keyed by transaction id. They
  // live in fin_settings so a Stessa re-import never overwrites them.
  const TX_EDIT_FIELDS = ['date', 'description', 'notes', 'category', 'sub_category', 'bucket', 'amount'];
  const txEdits = () => settings.tx_edits || {};
  function applyEdits(t) {
    const e = txEdits()[t.id];
    return e ? { ...t, ...e, original: t } : t;
  }
  const prepareTx = (rows) => rows.map(applyEdits).map(serviceMonth);

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
      activity = act;
      settings = Object.fromEntries(set.data.map((r) => [r.key, r.value]));
      transactions = prepareTx(tx);
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

  const FB = window.FinanceBuckets;
  const isMileage = (t) => t.sub_category === 'Mileage';
  // Cash transactions for the year: no transfers (card payments etc.) and no
  // Stessa mileage entries - mileage isn't cash; it's shown separately from
  // the activity log, which is the complete mileage record.
  const yearTx = () => transactions.filter((t) => !t.excluded && yearOf(t.date) === year && t.category !== 'Transfers' && !isMileage(t));
  const yearActivity = () => activity.filter((a) => !a.excluded && yearOf(a.date) === year);

  function byMonth(rows, pick = (t) => t.amount) {
    const m = Array(12).fill(0);
    rows.forEach((t) => (m[monthOf(t.date)] += Number(pick(t))));
    return m;
  }
  const sum = (arr) => arr.reduce((s, n) => s + n, 0);
  // Summed in whole cents so totals are exact to the penny.
  const total = (rows) => sum(rows.map((t) => Math.round(Number(t.amount) * 100))) / 100;
  const swatch = (color) => el('span', { class: 'bucket-dot', style: `background:${color}` });

  function renderOverview() {
    const tx = [...yearTx(), ...matchActivity().logOnly.map(logExpense)];
    const income = tx.filter((t) => t.category === 'Income');
    const expenses = tx.filter((t) => t.category !== 'Income');
    const mortgage = expenses.filter((t) => t.category === 'Mortgages & Loans');
    const opex = expenses.filter((t) => !NOT_OPEX.has(t.category));
    const acts = yearActivity();
    const miles = sum(acts.map((a) => Number(a.miles)));
    const hours = sum(acts.map((a) => Number(a.hours)));
    const rate = mileageRate(year);
    const net = total(income) + total(expenses);

    const kpi = (label, value, sub, tone) =>
      el('div', { class: 'kpi' }, el('div', { class: 'stat-label' }, label), el('div', { class: `stat-value ${tone || ''}` }, value), sub ? el('div', { class: 'stat-sub' }, sub) : null);
    document.getElementById('kpis').replaceChildren(
      kpi('Rental income', money(total(income)), `${year} to date`),
      kpi('Operating expenses', money(-total(opex)), 'utilities, cleaning, HOA, supplies…'),
      kpi('Mortgage', money(-total(mortgage)), 'principal + interest'),
      kpi('Net cash flow', money(net), 'income minus all expenses', net >= 0 ? 'good' : 'bad'),
      kpi('Miles logged', Math.round(miles).toLocaleString(), rate ? `≈ ${money(miles * rate)} deduction at $${rate}/mi` : 'set the mileage rate on the Taxes tab'),
      kpi('Hours logged', round2(hours).toLocaleString(), 'material participation log')
    );

    renderChart(income, expenses);
    renderPl(income, expenses, acts, rate);
  }

  // Income bars next to expense bars stacked by bucket (in the workbook's
  // colors), with the net cash flow line on top.
  function renderChart(income, expenses) {
    const incomeM = byMonth(income);
    const expenseM = byMonth(expenses);
    const bucketSets = FB.BUCKETS
      .map((b) => ({ b, m: byMonth(expenses.filter((t) => FB.bucketOf(t) === b.name)) }))
      .filter(({ m }) => sum(m.map(Math.abs)) >= 0.005)
      .map(({ b, m }) => ({ type: 'bar', label: b.name, stack: 'expenses', data: m.map((v) => round2(-v)), backgroundColor: b.color }));

    if (chart) chart.destroy();
    chart = new Chart(document.getElementById('cashChart'), {
      data: {
        labels: MONTHS,
        datasets: [
          { type: 'bar', label: 'Income', stack: 'income', data: incomeM.map(round2), backgroundColor: FB.INCOME.color },
          ...bucketSets,
          { type: 'line', label: 'Net cash flow', stack: 'net', data: incomeM.map((v, i) => round2(v + expenseM[i])), borderColor: '#111827', backgroundColor: '#111827', tension: 0.2 },
        ],
      },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: (v) => money(v, false) } } },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12 } },
          tooltip: {
            filter: (item) => Math.abs(item.parsed.y) >= 0.005,
            callbacks: { label: (c) => `${c.dataset.label}: ${money(c.parsed.y)}` },
          },
        },
      },
    });
  }

  // Every number in the P&L keeps the list of transactions (or activity
  // entries) behind it, shown in a popup on hover.
  let cellDetails = new Map();

  function renderPl(income, expenses, acts, rate) {
    cellDetails = new Map();
    let nextKey = 0;
    const table = document.getElementById('plTable');
    const head = el('thead', null, el('tr', null, el('th', null, String(year)), MONTHS.map((m) => el('th', null, m)), el('th', null, 'Total')));
    const rows = [];

    const valueCell = (amount, detail) => {
      if (Math.abs(amount) < 0.005 && !detail.rows.length) return el('td', { class: 'muted' }, '-');
      const key = String(nextKey++);
      cellDetails.set(key, detail);
      return el('td', { class: `hoverable${amount < 0 ? ' neg' : ''}`, 'data-cell': key, tabindex: '0' }, money(amount));
    };
    // One P&L line: a cell per month plus a total, each with its transactions.
    const line = (label, lineRows, opts = {}) => {
      const cells = MONTHS.map((m, i) => {
        const r = lineRows.filter((t) => monthOf(t.date) === i);
        return valueCell(total(r), { kind: 'tx', title: `${label} · ${m} ${year}`, rows: r });
      });
      cells.push(valueCell(total(lineRows), { kind: 'tx', title: `${label} · all of ${year}`, rows: lineRows }));
      rows.push(el('tr', { class: opts.cls || '', style: opts.color ? `--bucket:${opts.color}` : null },
        el('td', null, opts.color ? swatch(opts.color) : null, label), cells));
    };
    const section = (label) => rows.push(el('tr', { class: 'section' }, el('td', { colspan: 14 }, label)));

    section('Income');
    ['airbnb', 'vrbo', 'booking', 'direct'].forEach((p) => {
      const r = income.filter((x) => x.platform === p);
      if (r.length) line(PLATFORM_LABELS[p], r, { cls: 'sub', color: FB.INCOME.color });
    });
    const otherIncome = income.filter((x) => !x.platform);
    if (otherIncome.length) line('Other income', otherIncome, { cls: 'sub', color: FB.INCOME.color });
    line('Total income', income, { cls: 'total' });

    section('Expenses by bucket');
    FB.BUCKETS.forEach((b) => {
      const inBucket = expenses.filter((t) => FB.bucketOf(t) === b.name);
      if (!inBucket.length) return;
      line(b.name, inBucket, { cls: 'bucket-row', color: b.color });
      const subs = [...new Set(inBucket.map((t) => `${t.category || 'Uncategorized'} · ${t.sub_category || '-'}`))].sort();
      subs.forEach((s) => line(s, inBucket.filter((t) => `${t.category || 'Uncategorized'} · ${t.sub_category || '-'}` === s), { cls: 'sub', color: b.color }));
    });
    line('Total expenses', expenses, { cls: 'total' });

    line('Net cash flow', [...income, ...expenses], { cls: 'total' });

    if (rate) {
      const withMiles = acts.filter((a) => Number(a.miles) > 0);
      const color = FB.COLOR['Parking / Mileage'];
      const cells = MONTHS.map((m, i) => {
        const r = withMiles.filter((a) => monthOf(a.date) === i);
        const miles = sum(r.map((a) => Number(a.miles)));
        return valueCell(miles * rate, { kind: 'miles', rate, title: `Mileage · ${m} ${year}`, rows: r });
      });
      cells.push(valueCell(sum(withMiles.map((a) => Number(a.miles))) * rate, { kind: 'miles', rate, title: `Mileage · all of ${year}`, rows: withMiles }));
      rows.push(el('tr', { class: 'note', style: `--bucket:${color}` },
        el('td', null, swatch(color), `Mileage deduction (estimate, not cash) @ $${rate}/mi`), cells));
    }
    table.replaceChildren(head, el('tbody', null, rows));
  }

  // ---------- Hover popup for P&L numbers ----------

  const popover = el('div', { class: 'popover hidden', role: 'dialog', 'aria-live': 'polite' });
  document.body.appendChild(popover);
  let showTimer = null;
  let hideTimer = null;
  let pinnedCell = null;
  const POPUP_ROWS = 250;

  function popoverContent(d) {
    const rows = [...d.rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const shown = rows.slice(0, POPUP_ROWS);
    if (d.kind === 'miles') {
      const miles = sum(rows.map((a) => Number(a.miles)));
      return [
        el('div', { class: 'pop-head' }, el('strong', null, d.title),
          el('span', null, `${rows.length} trip${rows.length === 1 ? '' : 's'} · ${Math.round(miles).toLocaleString()} mi × $${d.rate} = ${money(miles * d.rate, true)}`)),
        el('table', { class: 'pop-table' },
          el('thead', null, el('tr', null, ['Date', 'Description', 'Who', 'Purpose', 'Miles', 'Deduction'].map((h) => el('th', null, h)))),
          el('tbody', null, shown.map((a) => el('tr', { style: `--bucket:${FB.COLOR[a.bucket] || FB.COLOR['Parking / Mileage']}` },
            el('td', { class: 'nowrap' }, dayLabel(a.date)), el('td', null, a.description), el('td', null, a.attendees || ''),
            el('td', null, a.purpose || ''), el('td', { class: 'num' }, String(Number(a.miles))), el('td', { class: 'num' }, money(a.miles * d.rate, true)))))),
      ];
    }
    return [
      el('div', { class: 'pop-head' }, el('strong', null, d.title),
        el('span', null, `${rows.length} transaction${rows.length === 1 ? '' : 's'} · ${money(total(rows), true)}`)),
      el('table', { class: 'pop-table' },
        el('thead', null, el('tr', null, ['Date', 'Payee', 'Description', 'Amount', 'Category', 'Account'].map((h) => el('th', null, h)))),
        el('tbody', null, shown.map((t) => {
          const bucket = FB.bucketOf(t);
          return el('tr', { style: `--bucket:${FB.COLOR[bucket]}` },
            el('td', { class: 'nowrap', title: t.paid_date ? 'Counted in the month the bill covers' : null },
              t.paid_date ? `${dayLabel(t.date)} (paid ${dayLabel(t.paid_date)})` : dayLabel(t.date)),
            el('td', null, t.description),
            el('td', { class: 'muted' }, t.notes || ''),
            el('td', { class: `num${t.amount < 0 ? ' neg' : ''}` }, money(Number(t.amount), true)),
            el('td', null, swatch(FB.COLOR[bucket]), `${t.category || 'Uncategorized'}${t.sub_category ? ' · ' + t.sub_category : ''}`),
            el('td', { class: 'muted' }, t.account || 'Entered in Stessa'));
        }))),
      rows.length > POPUP_ROWS ? el('div', { class: 'hint' }, `Showing the first ${POPUP_ROWS} of ${rows.length}.`) : null,
    ].filter(Boolean);
  }

  function showPopover(td) {
    const d = cellDetails.get(td.dataset.cell);
    if (!d) return;
    popover.replaceChildren(...popoverContent(d));
    popover.classList.remove('hidden');
    // Place below the number, or above it if there's no room; keep on screen.
    const r = td.getBoundingClientRect();
    const pw = popover.offsetWidth;
    const ph = popover.offsetHeight;
    const left = Math.max(8, Math.min(window.scrollX + r.left + r.width / 2 - pw / 2, window.scrollX + document.documentElement.clientWidth - pw - 8));
    const below = r.bottom + ph + 12 < window.innerHeight;
    popover.style.left = `${left}px`;
    popover.style.top = `${window.scrollY + (below ? r.bottom + 6 : r.top - ph - 6)}px`;
  }

  function hidePopover() {
    popover.classList.add('hidden');
    pinnedCell = null;
  }

  const plTable = document.getElementById('plTable');
  plTable.addEventListener('mouseover', (e) => {
    const td = e.target.closest('td[data-cell]');
    if (!td || pinnedCell) return;
    clearTimeout(hideTimer);
    clearTimeout(showTimer);
    showTimer = setTimeout(() => showPopover(td), 150);
  });
  plTable.addEventListener('mouseout', (e) => {
    if (!e.target.closest('td[data-cell]') || pinnedCell) return;
    clearTimeout(showTimer);
    hideTimer = setTimeout(hidePopover, 250);
  });
  // Click (or Enter) pins the popup open so it can be scrolled; click again,
  // click elsewhere or press Escape to close.
  plTable.addEventListener('click', (e) => {
    const td = e.target.closest('td[data-cell]');
    if (!td) return;
    e.stopPropagation();
    if (pinnedCell === td) return hidePopover();
    showPopover(td);
    pinnedCell = td;
  });
  plTable.addEventListener('keydown', (e) => {
    const td = e.target.closest('td[data-cell]');
    if (td && e.key === 'Enter') { showPopover(td); pinnedCell = td; }
  });
  plTable.addEventListener('focusin', (e) => {
    const td = e.target.closest('td[data-cell]');
    if (td && !pinnedCell) showPopover(td);
  });
  popover.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  popover.addEventListener('mouseleave', () => { if (!pinnedCell) hideTimer = setTimeout(hidePopover, 250); });
  popover.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => { if (!popover.classList.contains('hidden')) hidePopover(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePopover(); });

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

    renderLedger();
  }

  // ---------- Combined expense list (activity log + Stessa) ----------

  // One list of everything for the year: activity log entries (trips, hours,
  // purchases) and every expense imported from Stessa. A log purchase and a
  // Stessa transaction with the same amount within a week are the same
  // expense, so they're merged into one row. Stessa's own mileage rows are
  // left out - they copy the log's miles.
  const MATCH_DAYS = 7;
  // Payment handles that belong to a person in the log (PayPal/Venmo names).
  const PAYEE_ALIASES = { seahorsefig: 'Emma Bolander' };
  // Words in log entries that aren't payee names.
  const LEDGER_STOPWORDS = new Set(['autumn', 'star', 'point', 'kyle', 'stephanie', 'campbell', 'online', 'marketplace', 'listing', 'home', 'house', 'colorado', 'springs', 'monument', 'various']);
  const daysApart = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);

  // Pairs activity-log purchases with the imported transaction for the same
  // purchase. Returns the imported expenses, the pairs, and the log
  // purchases that count on their own (no import covers them).
  function matchActivity() {
    const acts = yearActivity();
    const expenses = transactions.filter((t) => !t.excluded && yearOf(t.date) === year
      && t.category !== 'Income' && t.category !== 'Transfers' && !isMileage(t));
    const matchedTx = new Map(); // activity id -> transaction
    const used = new Set();
    // Names in the log entry (e.g. "Baylie", "Walmart") are used to prefer
    // the transaction from the same payee - and when the name is a payee
    // that appears in the transactions, to require it, so one cleaner's log
    // entry is never paired with another cleaner's payment.
    const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
    // A transaction's payee text, plus the person behind known aliases.
    const payeeText = (t) => {
      const text = squash(`${t.description} ${t.notes || ''}`);
      const alias = Object.entries(PAYEE_ALIASES).find(([handle]) => text.includes(handle));
      return alias ? text + squash(alias[1]) : text;
    };
    const payees = expenses.map(payeeText);
    const words = (s) => String(s || '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4 && !LEDGER_STOPWORDS.has(w));
    [...acts].filter((a) => Number(a.amount) > 0).sort((a, b) => (a.date < b.date ? -1 : 1)).forEach((a) => {
      const cents = Math.round(Number(a.amount) * 100);
      // Vendor and people names both help pick the right transaction, but
      // only a person being paid (a name in "Who", like a cleaner) is
      // required - store words like "Park" also appear in unrelated payees.
      const allNames = words(`${a.vendor || ''} ${a.attendees || ''}`);
      const people = words(a.attendees);
      const sameName = (t) => allNames.some((w) => payeeText(t).includes(w));
      const samePerson = (t) => people.some((w) => payeeText(t).includes(w));
      const namedPayee = people.some((w) => payees.some((p) => p.includes(w)));
      const hit = expenses
        .filter((t) => !used.has(t.id) && Math.round(-Number(t.amount) * 100) === cents && daysApart(t.date, a.date) <= MATCH_DAYS)
        .filter((t) => !namedPayee || samePerson(t))
        .sort((p, q) => (sameName(q) - sameName(p)) || daysApart(p.date, a.date) - daysApart(q.date, a.date))[0];
      if (hit) {
        used.add(hit.id);
        matchedTx.set(a.id, hit);
      }
    });
    // Log purchases with no import match count as expenses themselves, unless
    // they're ticked "already in a bank/card import" (a match the rules miss).
    const logOnly = acts.filter((a) => Number(a.amount) > 0 && !matchedTx.has(a.id) && !a.already_imported);
    return { acts, expenses, matchedTx, used, logOnly };
  }

  // A counted log purchase in the same shape as an imported transaction.
  const logExpense = (a) => ({
    id: `act-${a.id}`,
    date: a.date,
    description: a.vendor || a.description,
    notes: [a.description, a.purpose].filter(Boolean).join(' - '),
    amount: -Number(a.amount),
    category: 'Activity log',
    sub_category: a.bucket || 'Other',
    account: 'Activity log (entered here)',
    bucket: a.bucket || 'Other',
  });

  function ledgerRows() {
    const { acts, expenses, matchedTx, used } = matchActivity();
    const txSource = (t) => `${t.account || 'Stessa entry'}${t.original ? ' (edited)' : ''}`;
    const txCategory = (t) => `${t.category || 'Uncategorized'}${t.sub_category ? ' · ' + t.sub_category : ''}`;
    const rows = acts.map((a) => {
      const t = matchedTx.get(a.id);
      return {
        key: `a${a.id}`,
        date: a.date,
        bucket: a.bucket || (t ? FB.bucketOf(t) : 'Other'),
        description: [a.description, a.purpose].filter(Boolean).join(' - '),
        payee: t ? t.description : a.vendor || '',
        who: a.attendees || '',
        category: t ? txCategory(t) : '',
        source: t ? `Log + ${txSource(t)}` : a.already_imported && Number(a.amount) > 0 ? 'Activity log (in an import)' : 'Activity log',
        miles: Number(a.miles) || 0,
        hours: Number(a.hours) || 0,
        amount: t ? Number(t.amount) : Number(a.amount) > 0 && !a.already_imported ? -Number(a.amount) : null,
        // The cost entered in the log, shown even when it's counted from an import.
        logCost: Number(a.amount) > 0 ? -Number(a.amount) : null,
        tx: t || null,
        notes: [a.notes, t && t.notes, !t && a.already_imported && Number(a.amount) > 0 ? `${money(Number(a.amount))} already counted from a bank/card import` : '']
          .filter(Boolean).join(' · '),
        activity: a,
      };
    });
    expenses.filter((t) => !used.has(t.id)).forEach((t) => rows.push({
      key: `t${t.id}`,
      date: t.date,
      bucket: FB.bucketOf(t),
      description: t.notes || '',
      payee: t.description,
      who: '',
      category: txCategory(t),
      source: txSource(t),
      miles: 0,
      hours: 0,
      amount: Number(t.amount),
      notes: t.paid_date ? `Paid ${dayLabel(t.paid_date)}, counted in the month it covers` : '',
      activity: null,
      tx: t,
    }));
    return rows;
  }

  // Filters: one per column. Text filters match "contains" (case-insensitive).
  const LEDGER_COLUMNS = [
    { key: 'date', label: 'Date', filter: 'dates' },
    { key: 'bucket', label: 'Bucket', filter: 'select' },
    { key: 'description', label: 'Description', filter: 'text' },
    { key: 'payee', label: 'Payee / vendor', filter: 'text' },
    { key: 'who', label: 'Who', filter: 'text' },
    { key: 'category', label: 'Category', filter: 'select' },
    { key: 'source', label: 'Source', filter: 'select' },
    { key: 'miles', label: 'Miles', filter: 'has' },
    { key: 'hours', label: 'Hours', filter: 'has' },
    { key: 'amount', label: 'Cost', filter: 'range' },
    { key: 'notes', label: 'Notes', filter: 'text' },
  ];
  let ledgerFilters = {};
  let ledgerSort = { key: 'date', dir: -1 };
  try { ledgerFilters = JSON.parse(localStorage.getItem('finance.ledgerFilters') || '{}'); } catch {}
  const saveFilters = () => { try { localStorage.setItem('finance.ledgerFilters', JSON.stringify(ledgerFilters)); } catch {} };

  function passes(r) {
    const f = ledgerFilters;
    if (f.dateFrom && r.date < f.dateFrom) return false;
    if (f.dateTo && r.date > f.dateTo) return false;
    for (const c of LEDGER_COLUMNS) {
      const v = f[c.key];
      if (v === undefined || v === '') continue;
      if (c.filter === 'text' && !String(r[c.key] || '').toLowerCase().includes(v.toLowerCase())) return false;
      if (c.filter === 'select' && r[c.key] !== v) return false;
      if (c.filter === 'has' && (v === 'yes' ? !r[c.key] : r[c.key])) return false;
    }
    // Amount range is on the size of the expense, whichever sign it has.
    const size = r.amount === null ? null : Math.abs(r.amount);
    if (f.amountMin !== undefined && f.amountMin !== '' && (size === null || size < Number(f.amountMin))) return false;
    if (f.amountMax !== undefined && f.amountMax !== '' && (size === null || size > Number(f.amountMax))) return false;
    return true;
  }

  function compare(a, b) {
    const k = ledgerSort.key;
    const x = a[k];
    const y = b[k];
    const empty = (v) => v === null || v === undefined || v === '';
    if (empty(x) && empty(y)) return 0;
    if (empty(x)) return 1;
    if (empty(y)) return -1;
    const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return r * ledgerSort.dir || (a.date < b.date ? 1 : -1);
  }

  function filterControl(c, rows) {
    const f = ledgerFilters;
    const set = (k) => (e) => { f[k] = e.target.value; saveFilters(); renderLedgerBody(); };
    const attrs = (k, extra) => ({ 'aria-label': `Filter ${c.label}`, value: f[k] ?? '', oninput: set(k), ...extra });
    if (c.filter === 'dates') {
      return el('div', { class: 'filter-dates' },
        el('input', attrs('dateFrom', { type: 'date', title: 'From' })),
        el('input', attrs('dateTo', { type: 'date', title: 'To' })));
    }
    if (c.filter === 'select') {
      const values = [...new Set(rows.map((r) => r[c.key]).filter(Boolean))].sort();
      const sel = el('select', { 'aria-label': `Filter ${c.label}`, onchange: set(c.key) },
        el('option', { value: '' }, 'All'), values.map((v) => el('option', { value: v }, v)));
      sel.value = values.includes(f[c.key]) ? f[c.key] : '';
      return sel;
    }
    if (c.filter === 'has') {
      const sel = el('select', { 'aria-label': `Filter ${c.label}`, onchange: set(c.key) },
        el('option', { value: '' }, 'All'), el('option', { value: 'yes' }, 'Has'), el('option', { value: 'no' }, 'None'));
      sel.value = f[c.key] || '';
      return sel;
    }
    if (c.filter === 'range') {
      return el('div', { class: 'filter-range' },
        el('input', attrs('amountMin', { type: 'number', step: '0.01', min: '0', placeholder: 'min' })),
        el('input', attrs('amountMax', { type: 'number', step: '0.01', min: '0', placeholder: 'max' })));
    }
    return el('input', attrs(c.key, { type: 'search', placeholder: 'contains…' }));
  }

  let ledgerAll = [];

  function renderLedger() {
    ledgerAll = ledgerRows();
    const head = el('thead', null,
      el('tr', null, LEDGER_COLUMNS.map((c) => el('th', {
        class: 'sortable',
        'aria-sort': ledgerSort.key === c.key ? (ledgerSort.dir > 0 ? 'ascending' : 'descending') : null,
        onclick: () => {
          ledgerSort = { key: c.key, dir: ledgerSort.key === c.key ? -ledgerSort.dir : c.key === 'date' || c.key === 'amount' ? -1 : 1 };
          renderLedger();
        },
      }, c.label, ledgerSort.key === c.key ? (ledgerSort.dir > 0 ? ' ▲' : ' ▼') : '')), el('th', null, '')),
      el('tr', { class: 'filter-row' }, LEDGER_COLUMNS.map((c) => el('th', null, filterControl(c, ledgerAll))),
        el('th', null, el('button', { class: 'btn btn-secondary', type: 'button', onclick: () => { ledgerFilters = {}; saveFilters(); renderLedger(); } }, 'Clear'))));
    document.getElementById('activityTable').replaceChildren(head, el('tbody', { id: 'ledgerBody' }));
    renderLedgerBody();
  }

  // Cost cell: what's counted, or the log's cost in gray when an import
  // already counts it, or a dash for trips/hours with no cost.
  function costCell(r) {
    if (r.amount !== null) return el('td', { class: `num${r.amount < 0 ? ' neg' : ''}` }, money(r.amount));
    if (r.logCost !== null && r.logCost !== undefined) {
      return el('td', { class: 'num muted', title: 'Already counted from a bank/card import' }, money(r.logCost));
    }
    return el('td', { class: 'num muted' }, '—');
  }

  let editingLedgerKey = null;

  function renderLedgerBody() {
    const rows = ledgerAll.filter(passes).sort(compare);
    const body = document.getElementById('ledgerBody');
    body.replaceChildren(...(rows.length
      ? rows.map((r) => (r.key === editingLedgerKey ? editRow(r) : el('tr', { class: 'bucketed', style: `--bucket:${FB.COLOR[r.bucket] || FB.COLOR.Other}` },
        el('td', { class: 'nowrap' }, dayLabel(r.date)),
        el('td', { class: 'nowrap' }, swatch(FB.COLOR[r.bucket] || FB.COLOR.Other), r.bucket),
        el('td', null, r.description),
        el('td', null, r.payee),
        el('td', null, r.who),
        el('td', { class: 'muted' }, r.category),
        el('td', { class: 'muted nowrap' }, r.source),
        el('td', { class: 'num' }, r.miles ? String(r.miles) : ''),
        el('td', { class: 'num' }, r.hours ? String(r.hours) : ''),
        costCell(r),
        el('td', { class: 'muted' }, r.notes),
        el('td', { class: 'row-actions' },
          el('button', { class: 'btn btn-secondary', type: 'button', onclick: () => { editingLedgerKey = r.key; renderLedgerBody(); } }, 'Edit'),
          r.activity ? el('button', { class: 'btn btn-warning', type: 'button', onclick: () => removeActivity(r.activity) }, 'Remove') : null))))
      : [el('tr', null, el('td', { colspan: LEDGER_COLUMNS.length + 1, class: 'muted' }, 'Nothing matches these filters.'))]));

    const spent = rows.reduce((s, r) => s + (r.amount === null ? 0 : Math.round(r.amount * 100)), 0) / 100;
    const miles = rows.reduce((s, r) => s + r.miles, 0);
    const hours = rows.reduce((s, r) => s + r.hours, 0);
    document.getElementById('ledgerSummary').textContent =
      `Showing ${rows.length} of ${ledgerAll.length} · ${money(spent)} · ${Math.round(miles).toLocaleString()} mi · ${round2(hours).toLocaleString()} h`;
  }

  // A row turned into inputs, edited in place in the table. Activity-log
  // fields save to the log; an imported transaction's fields (category,
  // payee, cost...) save as edits on top of the Stessa data. A log purchase
  // matched to a transaction edits both: the log entry, plus the
  // transaction's category.
  function editRow(r) {
    const a = r.activity;
    const t = r.tx;
    const field = (src, name, attrs = {}) => el('input', { class: 'cell-input', 'data-field': name, value: src[name] ?? '', ...attrs });
    const list = (id, values) => el('datalist', { id }, [...new Set(values.filter(Boolean))].sort().map((v) => el('option', { value: v })));
    const bucket = el('select', { class: 'cell-input', 'data-field': 'bucket' }, FB.BUCKETS.map((b) => el('option', { value: b.name }, b.name)));
    bucket.value = a ? a.bucket || r.bucket || 'General Supplies' : r.bucket;

    // Transaction inputs use "tx." field names; the cost is entered positive.
    const txField = (name, attrs = {}) => el('input', { class: 'cell-input', 'data-field': `tx.${name}`, value: t[name] ?? '', ...attrs });
    const category = t ? [
      txField('category', { type: 'text', placeholder: 'Category', list: 'catList' }),
      txField('sub_category', { type: 'text', placeholder: 'Sub-category', list: 'subList' }),
      list('catList', transactions.map((x) => x.category)),
      list('subList', transactions.map((x) => x.sub_category)),
    ] : r.category;

    let cells;
    if (a) {
      const imported = el('input', { type: 'checkbox', 'data-field': 'already_imported' });
      imported.checked = !!a.already_imported;
      cells = [
        el('td', null, field(a, 'date', { type: 'date' })),
        el('td', null, bucket),
        el('td', null, field(a, 'description', { type: 'text', placeholder: 'Description' }), field(a, 'purpose', { type: 'text', placeholder: 'Business purpose' })),
        el('td', null, field(a, 'vendor', { type: 'text', placeholder: 'Location / vendor' }), t ? el('div', { class: 'muted cell-note' }, t.description) : null),
        el('td', null, field(a, 'attendees', { type: 'text', placeholder: 'Who' })),
        el('td', null, category),
        el('td', null, el('label', { class: 'cell-check', title: 'Tick if a bank/card import already has this purchase' }, imported, ' In an import')),
        el('td', null, field(a, 'miles', { type: 'number', min: '0', step: '1' })),
        el('td', null, field(a, 'hours', { type: 'number', min: '0', step: '0.25' })),
        el('td', null, field(a, 'amount', { type: 'number', min: '0', step: '0.01', placeholder: 'Cost $' })),
        el('td', null, field(a, 'notes', { type: 'text', placeholder: 'Notes' })),
      ];
    } else {
      cells = [
        el('td', null, el('input', { class: 'cell-input', 'data-field': 'tx.date', type: 'date', value: t.paid_date || t.date })),
        el('td', null, bucket),
        el('td', null, txField('notes', { type: 'text', placeholder: 'Description' })),
        el('td', null, txField('description', { type: 'text', placeholder: 'Payee' })),
        el('td', null, ''),
        el('td', null, category),
        el('td', { class: 'muted nowrap' }, r.source),
        el('td', null, ''),
        el('td', null, ''),
        el('td', null, el('input', { class: 'cell-input', 'data-field': 'tx.amount', type: 'number', step: '0.01', value: round2(-Number(t.amount)), title: 'Cost (a refund is negative)' })),
        el('td', { class: 'muted' }, t.original ? `Stessa has: ${t.original.category || 'Uncategorized'}${t.original.sub_category ? ' · ' + t.original.sub_category : ''}, ${money(Number(t.original.amount))}` : ''),
      ];
    }
    const cancel = () => { editingLedgerKey = null; renderLedgerBody(); };
    const tr = el('tr', { class: 'bucketed editing', style: `--bucket:${FB.COLOR[bucket.value] || FB.COLOR.Other}` }, cells,
      el('td', { class: 'row-actions' },
        el('button', { class: 'btn btn-primary', type: 'button', onclick: () => saveRow(tr, r) }, 'Save'),
        el('button', { class: 'btn btn-secondary', type: 'button', onclick: cancel }, 'Cancel'),
        t && t.original ? el('button', { class: 'btn btn-warning', type: 'button', title: 'Undo the changes made here and go back to what Stessa has', onclick: () => revertTx(tr, t) }, 'Undo edits') : null,
        el('div', { class: 'save-status row-status' })));
    // A new category picks its usual bucket, unless the bucket was chosen by hand.
    let bucketTouched = false;
    bucket.addEventListener('change', () => {
      bucketTouched = true;
      tr.style.setProperty('--bucket', FB.COLOR[bucket.value] || FB.COLOR.Other);
    });
    tr.addEventListener('input', (e) => {
      if (!t || a || bucketTouched || !/^tx\.(category|sub_category|description)$/.test(e.target.dataset.field || '')) return;
      const v = (f) => tr.querySelector(`[data-field="tx.${f}"]`).value.trim();
      bucket.value = FB.bucketOf({ description: v('description'), category: v('category'), sub_category: v('sub_category') });
      tr.style.setProperty('--bucket', FB.COLOR[bucket.value] || FB.COLOR.Other);
    });
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') saveRow(tr, r);
      if (e.key === 'Escape') cancel();
    });
    setTimeout(() => tr.querySelector('input:not([type=date])').focus(), 0);
    return tr;
  }

  // Saves the edits for one transaction (null clears them). Reads the
  // current edits first so changes saved from another tab aren't lost.
  async function saveTxEdits(id, edits) {
    const { data, error: readError } = await db.from('fin_settings').select('value').eq('key', 'tx_edits').maybeSingle();
    if (readError) return readError;
    const all = { ...((data && data.value) || {}) };
    if (edits && Object.keys(edits).length) all[id] = edits;
    else delete all[id];
    const { error } = await db.from('fin_settings').upsert({ key: 'tx_edits', value: all, updated_at: new Date().toISOString() });
    if (!error) settings.tx_edits = all;
    return error;
  }

  async function reloadAfterEdit() {
    const [tx, act] = await Promise.all([fetchAll('fin_transactions', '*', 'date'), fetchAll('fin_activity', '*', 'date')]);
    transactions = prepareTx(tx);
    activity = act;
    renderAll();
  }

  async function saveRow(tr, r) {
    const a = r.activity;
    const t = r.tx;
    const status = tr.querySelector('.row-status');
    const val = (f) => tr.querySelector(`[data-field="${f}"]`);
    const text = (f) => val(f).value.trim() || null;
    const num = (f) => (val(f).value === '' ? null : Number(val(f).value));

    let activityRow = null;
    if (a) {
      if (!val('date').value || !text('description')) {
        status.textContent = 'Date and description are required';
        return;
      }
      activityRow = {
        date: val('date').value,
        bucket: val('bucket').value,
        description: text('description'),
        purpose: text('purpose'),
        vendor: text('vendor'),
        attendees: text('attendees'),
        miles: num('miles') ?? 0,
        hours: num('hours') ?? 0,
        amount: num('amount'),
        notes: text('notes'),
        already_imported: val('already_imported').checked,
      };
    }

    // Only fields that differ from what Stessa has are kept as edits.
    let edits = null;
    if (t) {
      const o = t.original || t;
      const next = { ...o, ...(txEdits()[t.id] || {}) };
      next.category = text('tx.category');
      next.sub_category = text('tx.sub_category');
      if (!a) {
        if (!val('tx.date').value || !text('tx.description') || num('tx.amount') === null) {
          status.textContent = 'Date, payee and cost are required';
          return;
        }
        next.date = val('tx.date').value;
        next.description = text('tx.description');
        next.notes = text('tx.notes');
        next.amount = round2(-num('tx.amount'));
        // The bucket is kept only when it isn't the one the category gives.
        next.bucket = val('bucket').value === FB.bucketOf({ ...next, bucket: null }) ? null : val('bucket').value;
      }
      edits = {};
      TX_EDIT_FIELDS.forEach((k) => {
        const before = k === 'amount' ? Number(o[k]) : o[k] ?? null;
        const after = k === 'amount' ? Number(next[k]) : next[k] ?? null;
        if (before !== after) edits[k] = next[k] ?? null;
      });
    }

    status.textContent = 'Saving...';
    if (activityRow) {
      const { error } = await db.from('fin_activity').update(activityRow).eq('id', a.id);
      if (error) {
        console.error(error);
        status.textContent = 'Save failed - see console';
        return;
      }
    }
    if (t) {
      const error = await saveTxEdits(t.id, edits);
      if (error) {
        console.error(error);
        status.textContent = 'Save failed - see console';
        return;
      }
    }
    editingLedgerKey = null;
    await reloadAfterEdit();
  }

  async function revertTx(tr, t) {
    if (!confirm(`Undo your changes to "${t.original.description}" on ${dayLabel(t.original.date)} and go back to what Stessa has?`)) return;
    const status = tr.querySelector('.row-status');
    status.textContent = 'Saving...';
    const error = await saveTxEdits(t.id, null);
    if (error) {
      console.error(error);
      status.textContent = 'Save failed - see console';
      return;
    }
    editingLedgerKey = null;
    await reloadAfterEdit();
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
      // Cleanings you do yourselves were colored General Supplies in the
      // workbook; the red Cleaning bucket is for paid cleaners.
      bucket: 'General Supplies',
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
    bucket: document.getElementById('aBucket'),
  };
  form.bucket.replaceChildren(...FB.BUCKETS.map((b) => el('option', { value: b.name }, b.name)));
  const showBucketColor = () => (form.bucket.style.borderLeft = `6px solid ${FB.COLOR[form.bucket.value] || FB.COLOR.Other}`);
  form.bucket.addEventListener('change', showBucketColor);

  function startEdit(a) {
    editingId = a.id || null;
    pendingBookingUid = null;
    Object.entries(form).forEach(([k, input]) => (input.value = a[k] === null || a[k] === undefined ? '' : a[k]));
    if (!form.bucket.value) form.bucket.value = 'General Supplies';
    showBucketColor();
    document.getElementById('aImported').checked = !!a.already_imported;
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
      bucket: form.bucket.value || null,
      already_imported: document.getElementById('aImported').checked,
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
    // The current month's bills may simply not be paid or imported yet (and
    // Black Hills drafts early next month), so it's "pending", not "missing".
    const currentMonth = year === now.getFullYear() ? now.getMonth() : -1;
    const emptyCell = (i) => {
      if (i === currentMonth) return el('td', { class: 'muted', title: 'Not paid or not imported yet this month' }, 'pending');
      if (i < lastMonth || (i === lastMonth && currentMonth === -1)) return el('td', { class: 'neg', title: 'Nothing found this month' }, 'missing');
      return el('td', { class: 'muted' }, '-');
    };
    document.getElementById('billsTable').replaceChildren(
      el('thead', null, el('tr', null, el('th', null, 'Bill'), MONTHS.map((m) => el('th', null, m)))),
      el('tbody', null, BILLS.map((b) => {
        const m = byMonth(tx.filter(b.test));
        return el('tr', null, el('td', null, b.label), m.map((v, i) => (Math.abs(v) >= 0.005 ? el('td', null, money(-v)) : emptyCell(i))));
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
      transactions = prepareTx(await fetchAll('fin_transactions', '*', 'date'));
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
