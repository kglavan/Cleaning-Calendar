(function () {
  const cfg = window.APP_CONFIG;
  const { createClient } = window.supabase;
  const db = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  const PLATFORMS = ['airbnb', 'vrbo', 'booking'];
  const HISTORY_DAYS = 90;
  // "Every open night" is the default date mode and runs one search per open
  // stay, so start with a single guest mix; add more mixes as needed.
  const DEFAULT_MIXES = [{ adults: 4, children: 0 }];
  const STAY_COLORS = ['#1f6feb', '#e8590c', '#7c3aed', '#0d9488', '#be185d', '#65a30d'];

  const RD = window.RankDates;
  // Our listing's size, used to pick like-for-like competitors for pricing.
  // Read from our own search card when we have one; this is the fallback.
  const DEFAULT_OUR_BEDROOMS = 3;
  // Never suggest moving more than this fraction in one step; big jumps are
  // shown as a first step with the market figure alongside.
  const MAX_PRICE_STEP = 0.2;
  // How far ahead the Calendar tab lists open dates.
  const OPENINGS_DAYS = 90;
  // Stays listed per grid cell before "+N more".
  const GRID_STAYS_SHOWN = 6;
  const guestCount = (m) => m.adults + m.children;

  let searches = [];
  let bookings = []; // read-only: the turnover calendar's synced bookings, for availability
  let snapshotsBySearch = new Map(); // search_id -> snapshots, oldest first
  let selectedSearchId = null;
  let chart = null;

  // ---------- Helpers ----------

  // Small DOM builder. Text always goes through textContent - competitor
  // titles come from scraped pages and must never be treated as HTML.
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

  const money = (n) => (n === null || n === undefined ? '-' : '$' + Math.round(n).toLocaleString());
  const platformLabel = (p) => cfg.SOURCE_LABELS[p] || p;
  const platformColor = (p) => cfg.SOURCE_COLORS[p] || '#888';
  const mixText = (m) => `${m.adults} adult${m.adults === 1 ? '' : 's'}${m.children ? ` + ${m.children} kid${m.children === 1 ? '' : 's'}` : ''}`;
  const mixKey = (m) => `${m.adults}_${m.children}`;

  function median(nums) {
    const v = nums.filter((n) => typeof n === 'number' && !Number.isNaN(n)).sort((a, b) => a - b);
    if (!v.length) return null;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  }

  function shortDate(iso) {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // "2026-10-28" -> "Oct 28" without timezone drift.
  function dayLabel(isoDate) {
    const [y, m, d] = isoDate.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  const stayLabel = (s) => `${dayLabel(s.checkin)}–${dayLabel(s.checkout)}`;
  const stayKey = (s) => `${s.checkin}_${s.checkout}`;
  const localDay = (iso) => new Date(iso).toLocaleDateString();

  function describeLocation(loc) {
    if (!/^https?:\/\//i.test(loc)) return loc;
    try {
      const u = new URL(loc);
      const q = u.searchParams.get('ss') || u.searchParams.get('destination') || decodeURIComponent(u.pathname.split('/')[2] || '').replace(/--/g, ', ').replace(/-/g, ' ');
      return `${q || u.hostname} (pasted URL)`;
    } catch {
      return loc;
    }
  }

  function describeDates(s) {
    if (s.date_mode === 'calendar') return `All open nights, next ${s.horizon_days} days`;
    if (s.date_mode === 'fixed') return `${dayLabel(s.fixed_checkin)}–${dayLabel(s.fixed_checkout)}`;
    if (s.date_mode === 'offset') return `${s.nights} nights, ${s.checkin_offset_days} days out`;
    return `Next ${s.open_windows} open ${s.nights}-night stay${s.open_windows === 1 ? '' : 's'}`;
  }

  // Rank status buckets used for color coding.
  function rankTone(snap) {
    if (!snap) return 'none';
    if (snap.status === 'found') return snap.page === 1 ? 'good' : snap.page <= 3 ? 'warn' : 'bad';
    if (snap.status === 'not_found') return 'bad';
    return 'none';
  }

  function rankShort(snap) {
    if (snap.status === 'found') return `#${snap.rank} · p${snap.page}`;
    if (snap.status === 'not_found') return `not in top ${snap.results_scanned}`;
    if (snap.status === 'blocked') return 'bot check';
    return 'error';
  }

  // Snapshots from the most recent tracker run (same local day) for a search.
  function latestRun(snaps) {
    if (!snaps.length) return [];
    const day = localDay(snaps[snaps.length - 1].run_at);
    return snaps.filter((s) => localDay(s.run_at) === day).sort((a, b) => (a.checkin < b.checkin ? -1 : 1));
  }

  // Best (lowest) rank found on the run closest to `days` ago.
  function bestRankDaysAgo(snaps, days) {
    const target = Date.now() - days * 86400000;
    const byDay = new Map();
    snaps.forEach((s) => {
      if (s.status !== 'found' || new Date(s.run_at).getTime() > target + 86400000) return;
      const d = localDay(s.run_at);
      byDay.set(d, Math.min(byDay.get(d) ?? Infinity, s.rank));
    });
    let best = null;
    let bestDist = Infinity;
    byDay.forEach((rank, d) => {
      const dist = Math.abs(new Date(d).getTime() - target);
      if (dist < bestDist) {
        best = rank;
        bestDist = dist;
      }
    });
    return best;
  }

  // ---------- Data ----------

  async function loadAll() {
    const since = new Date(Date.now() - HISTORY_DAYS * 86400000).toISOString();
    const [searchRes, snapRes, bookRes] = await Promise.all([
      db.from('rank_searches').select('*').order('created_at'),
      db
        .from('rank_snapshots')
        .select('id, search_id, run_at, checkin, checkout, status, rank, page, page_size, results_scanned, total_results, our_price, error')
        .gte('run_at', since)
        .order('run_at', { ascending: true }),
      db
        .from('bookings')
        .select('start_date, end_date')
        .eq('cancelled', false)
        .gte('end_date', RD.isoDay(new Date())),
    ]);
    if (bookRes.error) console.error('Failed to load bookings', bookRes.error);
    bookings = bookRes.data || [];
    if (searchRes.error) console.error('Failed to load searches', searchRes.error);
    if (snapRes.error) console.error('Failed to load snapshots', snapRes.error);

    searches = searchRes.data || [];
    snapshotsBySearch = new Map();
    (snapRes.data || []).forEach((s) => {
      if (!snapshotsBySearch.has(s.search_id)) snapshotsBySearch.set(s.search_id, []);
      snapshotsBySearch.get(s.search_id).push(s);
    });

    const latest = (snapRes.data || []).reduce((m, s) => (s.run_at > m ? s.run_at : m), '');
    document.getElementById('lastRun').textContent = latest
      ? `Last checked ${new Date(latest).toLocaleString()}`
      : 'Tracker has not run yet';

    renderGroups();
    renderSearchList();
    renderCalendarControls();
    if (currentView === 'calendar') renderCalendarView();
    if (selectedSearchId && searches.some((s) => s.id === selectedSearchId)) openDetail(selectedSearchId);
    else closeDetail();
  }

  // ---------- Overview: one grid per label ----------

  function cell(search) {
    if (!search) return el('td', { class: 'grid-cell empty' }, el('span', { class: 'muted' }, '-'));
    const snaps = snapshotsBySearch.get(search.id) || [];
    const run = latestRun(snaps);
    const found = run.filter((s) => s.status === 'found');
    const best = found.length ? found.reduce((a, b) => (b.rank < a.rank ? b : a)) : null;
    const lastWeek = bestRankDaysAgo(snaps, 7);

    let delta = null;
    if (best && lastWeek !== null && lastWeek !== undefined) {
      const diff = lastWeek - best.rank; // positive = moved up
      delta = el('span', { class: 'delta ' + (diff > 0 ? 'up' : diff < 0 ? 'down' : '') },
        diff === 0 ? '±0 wk' : `${diff > 0 ? '▲' : '▼'}${Math.abs(diff)} wk`);
    }

    return el('td', { class: 'grid-cell' },
      el('button', {
        class: 'cell-btn' + (search.active ? '' : ' paused') + (search.id === selectedSearchId ? ' selected' : ''),
        style: `--platform:${platformColor(search.platform)}`,
        title: `${platformLabel(search.platform)} · ${describeLocation(search.location)}`,
        onclick: () => openDetail(search.id),
      },
        run.length
          ? el('div', { class: 'cell-head' },
            el('span', { class: `cell-rank ${rankTone(best || run[0])}` }, best ? `#${best.rank}` : rankShort(run[0])),
            best ? el('span', { class: `chip ${rankTone(best)}` }, best.page === 1 ? 'Page 1' : `Page ${best.page}`) : null,
            delta)
          : el('div', { class: 'cell-head muted' }, search.active ? 'Waiting for first run' : 'Paused'),
        run.length > 1 || (run.length === 1 && !best)
          ? el('ul', { class: 'cell-stays' },
            run.slice(0, GRID_STAYS_SHOWN).map((s) => el('li', null, el('span', { class: 'muted' }, stayLabel(s)), ' ', el('span', { class: `tone-${rankTone(s)}` }, rankShort(s)))),
            run.length > GRID_STAYS_SHOWN ? el('li', { class: 'muted' }, `+${run.length - GRID_STAYS_SHOWN} more stays - see Calendar`) : null)
          : run.length === 1
            ? el('div', { class: 'cell-stays muted' }, stayLabel(run[0]))
            : null
      )
    );
  }

  function renderGroups() {
    const root = document.getElementById('searchGroups');
    root.innerHTML = '';
    document.getElementById('emptyState').classList.toggle('hidden', searches.length > 0);

    const groups = new Map();
    searches.forEach((s) => {
      if (!groups.has(s.label)) groups.set(s.label, []);
      groups.get(s.label).push(s);
    });

    groups.forEach((list, label) => {
      const platforms = PLATFORMS.filter((p) => list.some((s) => s.platform === p));
      const mixes = [];
      list.forEach((s) => {
        if (!mixes.some((m) => mixKey(m) === mixKey(s))) mixes.push({ adults: s.adults, children: s.children });
      });
      mixes.sort((a, b) => a.adults + a.children - (b.adults + b.children) || a.children - b.children);
      const dateModes = [...new Set(list.map(describeDates))];

      root.appendChild(
        el('section', { class: 'panel group' },
          el('div', { class: 'group-head' },
            el('h2', null, label),
            el('span', { class: 'modal-subtitle' }, dateModes.join(' · '))),
          el('div', { class: 'table-scroll' },
            el('table', { class: 'rank-grid' },
              el('thead', null, el('tr', null,
                el('th', null, 'Guests'),
                platforms.map((p) => {
                  const place = list.find((s) => s.platform === p);
                  return el('th', { style: `--platform:${platformColor(p)}` },
                    el('span', { class: 'dot', style: `background:${platformColor(p)};margin-right:6px` }), platformLabel(p),
                    el('div', { class: 'th-place' }, describeLocation(place.location)));
                }))),
              el('tbody', null, mixes.map((m) => el('tr', null,
                el('th', { class: 'mix-cell' }, mixText(m)),
                platforms.map((p) => cell(list.find((s) => s.platform === p && mixKey(s) === mixKey(m))))
              )))
            ))
        )
      );
    });
  }

  // ---------- Detail ----------

  async function openDetail(searchId) {
    selectedSearchId = searchId;
    const search = searches.find((s) => s.id === searchId);
    const snaps = snapshotsBySearch.get(searchId) || [];
    const run = latestRun(snaps);
    renderGroups();

    const panel = document.getElementById('detail');
    panel.classList.remove('hidden');
    document.getElementById('detailTitle').textContent = `${platformLabel(search.platform)} · ${search.label} · ${mixText(search)}`;
    document.getElementById('detailSubtitle').textContent =
      `${describeLocation(search.location)} · ${describeDates(search)}` +
      (run[0]?.total_results ? ` · ${run[0].total_results}` : '') +
      (snaps.length ? '' : ' · No results yet - the tracker will pick this up on its next run.');

    renderChart(snaps);

    const picker = document.getElementById('stayPicker');
    picker.replaceChildren(...run.map((s) => el('option', { value: s.id }, `${stayLabel(s)} (${rankShort(s)})`)));
    picker.onchange = () => loadStay(search, run.find((s) => s.id === picker.value));
    picker.disabled = run.length < 2;
    document.getElementById('detailRunDate').textContent = run.length ? new Date(run[0].run_at).toLocaleDateString() : '-';

    const best = run.filter((s) => s.status === 'found').sort((a, b) => a.rank - b.rank)[0] || run[0];
    if (best) picker.value = best.id;
    await loadStay(search, best);
    if (selectedSearchId === searchId) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function loadStay(search, snap) {
    const compBody = document.getElementById('compBody');
    compBody.innerHTML = '';
    document.getElementById('compareStats').innerHTML = '';
    document.getElementById('insights').innerHTML = '';
    if (!snap) return;

    const { data: comps, error } = await db
      .from('rank_competitors')
      .select('*')
      .eq('snapshot_id', snap.id)
      .order('position');
    if (error) {
      console.error('Failed to load competitors', error);
      return;
    }
    if (selectedSearchId !== search.id) return; // user clicked elsewhere meanwhile
    renderCompare(search, snap, comps);
    renderCompetitors(comps);
  }

  function closeDetail() {
    selectedSearchId = null;
    document.getElementById('detail').classList.add('hidden');
    renderGroups();
  }

  // One line per stay (check-in/check-out), since open-date searches check
  // several stays per run and the stays change as the calendar fills.
  function renderChart(snaps) {
    const days = [...new Set(snaps.map((s) => localDay(s.run_at)))];
    const stays = [];
    for (let i = snaps.length - 1; i >= 0 && stays.length < STAY_COLORS.length; i--) {
      if (!stays.some((k) => k.key === stayKey(snaps[i]))) stays.push({ key: stayKey(snaps[i]), label: stayLabel(snaps[i]) });
    }
    const pageSize = median(snaps.map((s) => s.page_size));
    const found = snaps.filter((s) => s.status === 'found');

    const datasets = stays.reverse().map((st, i) => ({
      label: st.label,
      data: days.map((d) => {
        const s = snaps.find((x) => localDay(x.run_at) === d && stayKey(x) === st.key && x.status === 'found');
        return s ? s.rank : null;
      }),
      borderColor: STAY_COLORS[i],
      backgroundColor: STAY_COLORS[i],
      spanGaps: true,
      tension: 0.2,
      pointRadius: 3,
    }));
    if (pageSize) {
      datasets.push({
        label: `End of page 1 (~#${Math.round(pageSize)})`,
        data: days.map(() => Math.round(pageSize)),
        borderColor: '#2e9e5b',
        borderDash: [6, 4],
        borderWidth: 1.5,
        pointRadius: 0,
      });
    }

    if (chart) chart.destroy();
    chart = new Chart(document.getElementById('rankChart'), {
      type: 'line',
      data: { labels: days.map((d) => shortDate(d)), datasets },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          y: {
            reverse: true,
            min: 1,
            suggestedMax: Math.max(pageSize || 0, ...found.map((s) => s.rank), 10) + 2,
            title: { display: true, text: 'Rank (1 = top)' },
            ticks: { precision: 0 },
          },
        },
        plugins: { legend: { position: 'bottom' } },
      },
    });
  }

  function stat(label, ours, theirs, fmt, betterWhenLower) {
    let tone = '';
    if (ours !== null && ours !== undefined && theirs !== null && theirs !== undefined) {
      const better = betterWhenLower ? ours <= theirs : ours >= theirs;
      tone = better ? 'good' : 'bad';
    }
    return el('div', { class: 'stat' },
      el('div', { class: 'stat-label' }, label),
      el('div', { class: `stat-value ${tone}` }, ours === null || ours === undefined ? '-' : fmt(ours)),
      el('div', { class: 'stat-sub' }, `page-1 median ${theirs === null || theirs === undefined ? '-' : fmt(theirs)}`)
    );
  }

  function renderCompare(search, snap, comps) {
    const page1 = comps.filter((c) => c.page === 1 && !c.is_ours);
    const ours = comps.find((c) => c.is_ours);
    const scale = page1.find((c) => c.rating_scale)?.rating_scale || (search.platform === 'airbnb' ? 5 : 10);
    const medPrice = median(page1.map((c) => (c.price === null ? null : Number(c.price))));
    const medRating = median(page1.map((c) => (c.rating === null ? null : Number(c.rating))));
    const medReviews = median(page1.map((c) => c.review_count));

    document.getElementById('compareStats').replaceChildren(
      stat('Your price (stay total)', ours ? Number(ours.price) : snap.our_price, medPrice, money, true),
      stat(`Your rating (/${scale})`, ours ? Number(ours.rating) : null, medRating, (n) => n.toFixed(2).replace(/\.?0+$/, ''), false),
      stat('Your reviews', ours ? ours.review_count : null, medReviews, (n) => Math.round(n).toLocaleString(), false)
    );

    document.getElementById('insights').replaceChildren(...buildInsights(search, snap, page1, ours, { medPrice, medRating, medReviews }).map((t) => el('li', null, t)));
  }

  // Plain rule-based suggestions from one stay's page-1 snapshot.
  function buildInsights(search, snap, page1, ours, med) {
    const out = [];
    const n = page1.length;

    if (snap.status === 'found' && snap.page === 1) {
      out.push(`You're on page 1 at #${snap.rank} of ${snap.page_size || n + 1} for ${stayLabel(snap)}.`);
    } else if (snap.status === 'found') {
      out.push(`You're #${snap.rank}, on page ${snap.page}, for ${stayLabel(snap)}. Page 1 holds about ${snap.page_size || n} listings.`);
    } else if (snap.status === 'not_found') {
      out.push(`Not found in the first ${snap.results_scanned} results for ${stayLabel(snap)}. If these dates are open, check min-stay / max-guest settings on this platform, and that the search area actually covers the listing (try pasting your own search URL).`);
    } else {
      out.push(`Last run: ${snap.status}${snap.error ? ` - ${snap.error}` : ''}.`);
    }

    const ourPrice = ours ? Number(ours.price) : snap.our_price;
    if (ourPrice && med.medPrice) {
      const pct = Math.round(((ourPrice - med.medPrice) / med.medPrice) * 100);
      if (pct >= 10) out.push(`Your price is ${pct}% above the page-1 median (${money(med.medPrice)}). Price relative to similar listings is one of the biggest ranking signals - try a small drop for these dates and watch the trend.`);
      else if (pct <= -15) out.push(`Your price is ${Math.abs(pct)}% below the page-1 median (${money(med.medPrice)}) - you may have room to raise it without losing position.`);
    }

    if (ours && ours.review_count !== null && med.medReviews && ours.review_count < med.medReviews * 0.5) {
      out.push(`Page-1 listings have a median of ${Math.round(med.medReviews)} reviews vs your ${ours.review_count}. Prompting every guest for a review helps.`);
    }
    if (ours && ours.rating !== null && med.medRating && Number(ours.rating) < med.medRating) {
      out.push(`Your rating (${ours.rating}) is below the page-1 median (${med.medRating.toFixed(2)}).`);
    }

    const countBadge = (b) => page1.filter((c) => (c.badges || []).includes(b)).length;
    if (search.platform === 'airbnb' && n) {
      const fav = page1.filter((c) => (c.badges || []).some((b) => /guest favorite/i.test(b))).length;
      if (fav) out.push(`${fav} of ${n} page-1 listings are Guest favorites${ours && !(ours.badges || []).some((b) => /guest favorite/i.test(b)) ? ' - you are not yet' : ''}.`);
      const disc = countBadge('Discounted');
      if (disc) out.push(`${disc} of ${n} page-1 listings are showing a discount (strikethrough price) for these dates.`);
    }
    const ads = page1.filter((c) => c.sponsored).length;
    if (ads) out.push(`${ads} page-1 spot(s) are paid/sponsored placements.`);
    if (search.platform === 'booking') {
      const deals = page1.filter((c) => (c.badges || []).some((b) => /deal|genius/i.test(b))).length;
      if (deals) out.push(`${deals} of ${n} page-1 properties show a Genius or Deal badge - joining those programs can lift placement.`);
    }
    return out;
  }

  function renderCompetitors(comps) {
    const body = document.getElementById('compBody');
    body.replaceChildren(
      ...comps.map((c) => {
        const title = c.url ? el('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer' }, c.title || c.listing_id) : c.title || c.listing_id;
        return el('tr', { class: c.is_ours ? 'ours' : '' },
          el('td', null, c.position, c.page > 1 ? el('span', { class: 'muted' }, ` (p${c.page})`) : null),
          el('td', null, title, c.is_ours ? el('span', { class: 'chip good' }, 'You') : null, c.sponsored ? el('span', { class: 'chip none' }, 'Ad') : null),
          el('td', null, money(c.price === null ? null : Number(c.price))),
          el('td', null, c.rating === null ? '-' : String(Math.round(Number(c.rating) * 100) / 100)),
          el('td', null, c.review_count === null ? '-' : c.review_count.toLocaleString()),
          el('td', { class: 'badges' }, (c.badges || []).join(', '))
        );
      })
    );
  }

  document.getElementById('detailClose').addEventListener('click', closeDetail);

  // ---------- Calendar view ----------

  const PLATFORM_LETTER = { airbnb: 'A', vrbo: 'V', booking: 'B' };
  let currentView = 'grid';
  let calMonth = null; // 'YYYY-MM'
  let calRenderToken = 0;

  const nightsBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function setView(view) {
    currentView = view;
    try {
      localStorage.setItem('rankings.view', view);
    } catch {}
    document.getElementById('gridView').classList.toggle('hidden', view !== 'grid');
    document.getElementById('calendarView').classList.toggle('hidden', view !== 'calendar');
    ['Grid', 'Calendar'].forEach((v) => {
      const tab = document.getElementById('tab' + v);
      tab.classList.toggle('active', v.toLowerCase() === view);
      tab.setAttribute('aria-selected', String(v.toLowerCase() === view));
    });
    if (view === 'calendar') renderCalendarView();
  }
  document.getElementById('tabGrid').addEventListener('click', () => setView('grid'));
  document.getElementById('tabCalendar').addEventListener('click', () => setView('calendar'));

  function renderCalendarControls() {
    const labelSel = document.getElementById('calLabel');
    const labels = [...new Set(searches.map((s) => s.label))];
    // Prefer a label with "every open night" searches - those fill the calendar.
    const preferred = labels.find((l) => searches.some((s) => s.label === l && s.date_mode === 'calendar')) || labels[0];
    const keep = labels.includes(labelSel.value) ? labelSel.value : preferred;
    labelSel.replaceChildren(...labels.map((l) => el('option', { value: l }, l)));
    if (keep) labelSel.value = keep;
    renderMixOptions();
  }

  function renderMixOptions() {
    const mixSel = document.getElementById('calMix');
    const label = document.getElementById('calLabel').value;
    const mixesHere = [];
    searches.filter((s) => s.label === label).forEach((s) => {
      if (!mixesHere.some((m) => mixKey(m) === mixKey(s))) mixesHere.push({ adults: s.adults, children: s.children });
    });
    mixesHere.sort((a, b) => a.adults + a.children - (b.adults + b.children) || a.children - b.children);
    const keep = mixSel.value;
    const lastChecked = (m) => {
      let last = '';
      searches.filter((s) => s.label === label && mixKey(s) === mixKey(m)).forEach((s) => {
        const snaps = snapshotsBySearch.get(s.id) || [];
        const t = snaps.length ? snaps[snaps.length - 1].run_at : '';
        if (t > last) last = t;
      });
      return last;
    };
    mixSel.replaceChildren(...mixesHere.map((m) => {
      const last = lastChecked(m);
      return el('option', { value: mixKey(m) },
        `${guestCount(m)} guests · ${mixText(m)} · ${last ? 'checked ' + shortDate(last) : 'not checked yet'}`);
    }));
    if (mixesHere.some((m) => mixKey(m) === keep)) mixSel.value = keep;
  }

  document.getElementById('calLabel').addEventListener('change', () => {
    renderMixOptions();
    renderCalendarView();
  });
  document.getElementById('calMix').addEventListener('change', renderCalendarView);
  document.getElementById('calPrev').addEventListener('click', () => shiftMonth(-1));
  document.getElementById('calNext').addEventListener('click', () => shiftMonth(1));

  function shiftMonth(delta) {
    const [y, m] = calMonth.split('-').map(Number);
    calMonth = new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
    renderCalendarView();
  }

  // For one label + guest mix: per platform, the newest snapshot covering
  // each night that actually has a result. A bot-check block or failed run
  // doesn't hide an older real result; it only shows when nothing better
  // exists for that night.
  function coverageFor(list) {
    const hasResult = (s) => s.status === 'found' || s.status === 'not_found';
    const byPlatform = {};
    list.forEach((search) => {
      const nights = (byPlatform[search.platform] ??= new Map());
      (snapshotsBySearch.get(search.id) || []).forEach((snap) => {
        for (let d = snap.checkin; d < snap.checkout; d = RD.addDays(d, 1)) {
          const prev = nights.get(d);
          const better = !prev
            || (hasResult(snap) && !hasResult(prev))
            || (hasResult(snap) === hasResult(prev) && prev.run_at < snap.run_at);
          if (better) nights.set(d, snap);
        }
      });
    });
    return byPlatform;
  }

  async function loadPricingComps(snapIds) {
    const bySnap = new Map();
    for (let i = 0; i < snapIds.length; i += 15) {
      const { data, error } = await db
        .from('rank_competitors')
        .select('snapshot_id, page, price, bedrooms, is_ours')
        .in('snapshot_id', snapIds.slice(i, i + 15));
      if (error) {
        console.error('Failed to load competitor prices', error);
        continue;
      }
      data.forEach((c) => {
        if (!bySnap.has(c.snapshot_id)) bySnap.set(c.snapshot_id, []);
        bySnap.get(c.snapshot_id).push(c);
      });
    }
    return bySnap;
  }

  // Suggested all-in price per night for one searched stay. Rules of thumb:
  //  - strong page-1 spot (top 5): hold, unless you're cheap vs similar listings
  //  - lower on page 1: don't sit above the similar-listing median
  //  - not on page 1: aim for the lower-middle of similar listings (40th
  //    percentile), or the bottom quarter when check-in is under 10 days out
  function suggestForStay(snap, comps, ourBedrooms) {
    const nights = nightsBetween(snap.checkin, snap.checkout);
    const page1 = comps.filter((c) => c.page === 1 && !c.is_ours && c.price);
    const similar = page1.filter((c) => c.bedrooms !== null && Math.abs(c.bedrooms - ourBedrooms) <= 1);
    const pool = similar.length >= 4 ? similar : page1;
    if (pool.length < 3) return null;
    const perNight = pool.map((c) => Number(c.price) / nights).sort((a, b) => a - b);
    const ours = comps.find((c) => c.is_ours && c.price);
    const ourNight = ours ? Number(ours.price) / nights : snap.our_price ? Number(snap.our_price) / nights : null;
    const daysOut = nightsBetween(RD.isoDay(new Date()), snap.checkin);
    const q25 = quantile(perNight, 0.25);
    const q40 = quantile(perNight, 0.4);
    const q50 = quantile(perNight, 0.5);

    let target;
    let why;
    if (snap.status === 'found' && snap.page === 1 && snap.rank <= 5) {
      const cheap = ourNight !== null && ourNight < q40;
      target = cheap ? q40 : ourNight ?? q50;
      why = cheap ? 'strong spot, cheaper than similar listings - room to raise' : 'strong page-1 spot - hold';
    } else if (snap.status === 'found' && snap.page === 1) {
      target = ourNight !== null ? Math.min(ourNight, q50) : q50;
      why = ourNight !== null && ourNight > q50 ? 'on page 1 but pricier than similar listings' : 'on page 1 - hold';
    } else {
      const aim = daysOut <= 10 ? q25 : q40;
      if (ourNight !== null && ourNight <= aim) {
        // Already cheaper than most similar listings: a price cut is unlikely
        // to be what gets you onto page 1.
        target = ourNight;
        why = "already cheaper than similar listings - price isn't the issue; check photos, title, reviews, min-stay";
      } else {
        target = aim;
        why = daysOut <= 10 ? 'not on page 1, check-in soon - price to fill' : 'not on page 1 - move into the lower-middle of similar listings';
      }
    }
    if (ourNight !== null && target !== null) {
      const capped = Math.min(ourNight * (1 + MAX_PRICE_STEP), Math.max(ourNight * (1 - MAX_PRICE_STEP), target));
      if (Math.round(capped) !== Math.round(target)) {
        why += ` (first step of ${Math.round(MAX_PRICE_STEP * 100)}% - similar page-1 listings are around ${money(target)}/night)`;
        target = capped;
      }
    }
    return { target, ourNight, why };
  }

  function ourBedroomsFrom(compsBySnap) {
    for (const list of compsBySnap.values()) {
      const ours = list.find((c) => c.is_ours && c.bedrooms !== null);
      if (ours) return ours.bedrooms;
    }
    return DEFAULT_OUR_BEDROOMS;
  }

  async function renderCalendarView() {
    const token = ++calRenderToken;
    const label = document.getElementById('calLabel').value;
    const mix = document.getElementById('calMix').value;
    const list = searches.filter((s) => s.label === label && mixKey(s) === mix);
    const today = RD.isoDay(new Date());
    if (!calMonth) calMonth = today.slice(0, 7);
    const coverage = coverageFor(list);
    const platforms = PLATFORMS.filter((p) => list.some((s) => s.platform === p));
    const taken = RD.bookedNights(bookings);

    // ---- month grid ----
    const [y, m] = calMonth.split('-').map(Number);
    document.getElementById('calMonth').textContent = new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const cells = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => el('div', { class: 'cal-dow' }, d));
    for (let i = 0; i < firstDow; i++) cells.push(el('div', { class: 'cal-day blank' }));
    for (let day = 1; day <= daysInMonth; day++) {
      const iso = `${calMonth}-${String(day).padStart(2, '0')}`;
      const past = iso < today;
      const booked = taken.has(iso);
      const chips = !past && !booked
        ? platforms.map((p) => {
          const snap = coverage[p] && coverage[p].get(iso);
          const text = !snap ? '–' : snap.status === 'found' ? `p${snap.page}` : snap.status === 'not_found' ? 'off' : '?';
          const tip = !snap ? `${platformLabel(p)} · not checked yet` : `${platformLabel(p)} · ${stayLabel(snap)} · ${rankShort(snap)}`;
          return el('span', { class: `chip ${snap ? rankTone(snap) : 'none'}`, title: tip }, `${PLATFORM_LETTER[p]} ${text}`);
        })
        : [];
      cells.push(el('div', {
        class: 'cal-day' + (past ? ' past' : '') + (booked ? ' booked' : '') + (iso === today ? ' today' : ''),
        onclick: !past && !booked ? () => highlightOpening(iso) : null,
      },
        el('div', { class: 'cal-date' }, day),
        booked && !past ? el('div', { class: 'cal-booked' }, 'Booked') : null,
        chips.length ? el('div', { class: 'cal-chips' }, chips) : null));
    }
    document.getElementById('calGrid').replaceChildren(...cells);

    // ---- openings with price suggestions ----
    const openingsEl = document.getElementById('openings');
    if (!list.length) {
      openingsEl.replaceChildren(el('p', { class: 'muted' }, 'Add a search to see open dates here.'));
      return;
    }
    const horizon = Math.max(OPENINGS_DAYS, ...list.map((s) => (s.date_mode === 'calendar' ? s.horizon_days : 0)));
    const gaps = RD.openGaps(bookings, today, RD.addDays(today, horizon));
    const snapIds = [...new Set(platforms.flatMap((p) => [...(coverage[p] ? coverage[p].values() : [])].map((s) => s.id)))];
    const compsBySnap = snapIds.length ? await loadPricingComps(snapIds) : new Map();
    if (token !== calRenderToken) return; // a newer render started meanwhile
    const ourBedrooms = ourBedroomsFrom(compsBySnap);

    openingsEl.replaceChildren(...(gaps.length
      ? gaps.map((gap) => renderOpening(gap, platforms, coverage, compsBySnap, ourBedrooms))
      : [el('p', { class: 'muted' }, `No open nights in the next ${horizon} days.`)]));
  }

  // Openings longer than a week get one price table per week, since weekday
  // and weekend demand (and so pricing) differ.
  function renderOpening(gap, platforms, coverage, compsBySnap, ourBedrooms) {
    const nights = nightsBetween(gap.start, gap.end);
    const parts = [];
    if (nights <= 8) parts.push(gap);
    else {
      for (let s = gap.start; s < gap.end; ) {
        let e = RD.addDays(s, 7);
        if (e > gap.end || nightsBetween(e, gap.end) < 2) e = gap.end;
        parts.push({ start: s, end: e });
        s = e;
      }
    }
    return el('div', { class: 'opening', 'data-start': gap.start, 'data-end': gap.end },
      el('div', { class: 'opening-head' },
        el('strong', null, `${dayLabel(gap.start)} – ${dayLabel(gap.end)}`),
        el('span', { class: 'muted' }, ` · ${nights} night${nights === 1 ? '' : 's'} open`)),
      parts.map((part) => el('div', { class: 'opening-part' },
        parts.length > 1 ? el('div', { class: 'part-head' }, `${dayLabel(part.start)} – ${dayLabel(part.end)}`) : null,
        openingTable(part, platforms, coverage, compsBySnap, ourBedrooms))));
  }

  function openingTable(gap, platforms, coverage, compsBySnap, ourBedrooms) {
    const rows = platforms.map((p) => {
      // Distinct stays checked inside this gap for this platform.
      const snaps = [];
      for (let d = gap.start; d < gap.end; d = RD.addDays(d, 1)) {
        const snap = coverage[p] && coverage[p].get(d);
        if (snap && !snaps.includes(snap)) snaps.push(snap);
      }
      const name = el('td', null, el('span', { class: 'dot', style: `background:${platformColor(p)};margin-right:6px` }), platformLabel(p));
      if (!snaps.length) {
        return el('tr', null, name, el('td', { colspan: 3, class: 'muted' }, 'Not checked yet - the tracker covers these nights on its next run.'));
      }
      const found = snaps.filter((s) => s.status === 'found');
      const pages = found.map((s) => s.page);
      const lo = Math.min(...pages);
      const hi = Math.max(...pages);
      const where = found.length
        ? `${lo === hi ? `Page ${lo}` : `Pages ${lo}–${hi}`} (best #${Math.min(...found.map((s) => s.rank))})`
        : snaps.some((s) => s.status === 'not_found') ? 'Not found in results scanned' : 'Check failed';
      const tone = found.length ? rankTone(found.reduce((a, b) => (b.rank < a.rank ? b : a))) : 'bad';

      const sugg = snaps.map((s) => suggestForStay(s, compsBySnap.get(s.id) || [], ourBedrooms)).filter(Boolean);
      const target = median(sugg.map((x) => x.target));
      const ourNight = median(sugg.map((x) => x.ourNight).filter((v) => v !== null));
      const change = target !== null && ourNight !== null ? Math.round(target - ourNight) : null;
      // The most common reason across the stays in this range.
      const counts = new Map();
      sugg.forEach((x) => counts.set(x.why, (counts.get(x.why) || 0) + 1));
      const why = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';

      let suggested = el('span', { class: 'muted' }, 'not enough data');
      if (target !== null) {
        const note = change === null ? null
          : Math.abs(change) < 5 ? el('span', { class: 'muted' }, ' (hold)')
            : el('span', { class: 'delta ' + (change < 0 ? 'down' : 'up') }, ` (${change < 0 ? '−' : '+'}${Math.abs(change)})`);
        suggested = el('span', null, el('strong', null, `${money(target)}/night`), note);
      }
      const whyLine = why ? el('div', { class: 'why' }, why) : null;

      return el('tr', null,
        name,
        el('td', null, el('span', { class: `tone-${tone}` }, where)),
        el('td', null, ourNight !== null ? `${money(ourNight)}/night` : el('span', { class: 'muted' }, 'n/a')),
        el('td', { class: 'sugg' }, el('div', { class: 'sugg-price' }, suggested), whyLine));
    });

    return el('div', { class: 'table-scroll' },
      el('table', { class: 'comp-table opening-table' },
        el('thead', null, el('tr', null, ['Platform', 'Where you show up', 'You now (all-in)', 'Suggested (all-in)'].map((h) => el('th', null, h)))),
        el('tbody', null, rows)));
  }

  function highlightOpening(iso) {
    document.querySelectorAll('.opening.highlight').forEach((n) => n.classList.remove('highlight'));
    const target = [...document.querySelectorAll('.opening')].find((n) => n.dataset.start <= iso && iso < n.dataset.end);
    if (!target) return;
    target.classList.add('highlight');
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ---------- Saved search management ----------

  function renderSearchList() {
    const body = document.getElementById('searchList');
    if (!searches.length) {
      body.replaceChildren(el('tr', null, el('td', { colspan: 7, class: 'muted' }, 'None yet.')));
      return;
    }
    body.replaceChildren(
      ...searches.map((s) =>
        el('tr', { class: s.active ? '' : 'paused' },
          el('td', null, el('span', { class: 'dot', style: `background:${platformColor(s.platform)};margin-right:6px` }), platformLabel(s.platform)),
          el('td', null, s.label),
          el('td', { class: 'loc-cell', title: s.location }, describeLocation(s.location)),
          el('td', { class: 'nowrap' }, mixText(s)),
          el('td', { class: 'nowrap' }, describeDates(s)),
          el('td', null, s.max_pages),
          el('td', { class: 'row-actions' },
            el('button', { class: 'btn btn-secondary', onclick: () => setActive(s, !s.active) }, s.active ? 'Pause' : 'Resume'),
            el('button', { class: 'btn btn-warning', onclick: () => removeSearch(s) }, 'Delete')
          )
        )
      )
    );
  }

  async function setActive(search, active) {
    const { error } = await db.from('rank_searches').update({ active }).eq('id', search.id);
    if (error) console.error(error);
    await loadAll();
  }

  async function removeSearch(search) {
    if (!confirm(`Delete "${search.label}" (${mixText(search)}) on ${platformLabel(search.platform)} and all of its history?`)) return;
    const { error } = await db.from('rank_searches').delete().eq('id', search.id);
    if (error) console.error(error);
    if (selectedSearchId === search.id) selectedSearchId = null;
    await loadAll();
  }

  // ---------- Add Search modal ----------

  const modal = document.getElementById('searchModalOverlay');
  let mixes = [];

  const adultsSel = document.getElementById('mixAdults');
  const kidsSel = document.getElementById('mixKids');
  for (let i = 1; i <= 8; i++) adultsSel.appendChild(el('option', { value: i }, `${i} adult${i === 1 ? '' : 's'}`));
  for (let i = 0; i <= 6; i++) kidsSel.appendChild(el('option', { value: i }, i ? `${i} kid${i === 1 ? '' : 's'}` : 'no kids'));
  adultsSel.value = '2';

  const dateMode = () => document.querySelector('input[name="dateMode"]:checked').value;
  const checkedPlatforms = () => [...document.querySelectorAll('[data-platform]:checked')].map((i) => i.dataset.platform);
  const locationFor = (p) => document.querySelector(`[data-location="${p}"]`).value.trim();

  function renderMixes() {
    document.getElementById('mixChips').replaceChildren(
      ...mixes.map((m, i) => el('span', { class: 'mix-chip' }, mixText(m),
        el('button', { type: 'button', 'aria-label': `Remove ${mixText(m)}`, onclick: () => { mixes.splice(i, 1); renderMixes(); } }, '×')))
    );
    updateVolume();
  }

  // How many stays one saved search will check per run, from today's calendar.
  function staysPerSearch() {
    const mode = dateMode();
    if (mode === 'fixed') return 1;
    if (mode === 'open_dates') return parseInt(document.getElementById('sWindows').value, 10) || 1;
    return RD.calendarStays(bookings, {
      nights: parseInt(document.getElementById('sNights').value, 10) || 3,
      horizonDays: parseInt(document.getElementById('sHorizon').value, 10) || 45,
    }).length;
  }

  function updateDateFields() {
    const mode = dateMode();
    document.getElementById('openDatesFields').classList.toggle('hidden', mode === 'fixed');
    document.getElementById('fixedDatesFields').classList.toggle('hidden', mode !== 'fixed');
    document.getElementById('windowsField').classList.toggle('hidden', mode !== 'open_dates');
    document.getElementById('horizonField').classList.toggle('hidden', mode !== 'calendar');
    document.getElementById('datesHint').textContent =
      mode === 'calendar'
        ? 'Splits every open stretch on your calendar into stays of about this many nights, so every open night gets a rank in the Calendar view. Uses the bookings synced from all three platforms.'
        : mode === 'open_dates'
          ? 'Each run picks the soonest open stays of that length, a week apart, using the bookings synced from all three platforms.'
          : '';
    updateVolume();
  }

  function updateVolume() {
    const stays = staysPerSearch();
    const n = checkedPlatforms().length * mixes.length;
    // "Every open night" mixes take turns - each run checks one mix - so the
    // per-run cost is one mix's worth; other modes run every mix every time.
    const rotating = dateMode() === 'calendar';
    const mixesPerRun = rotating ? Math.min(1, mixes.length) : mixes.length;
    const perDay = checkedPlatforms().length * mixesPerRun * stays;
    const vrbo = checkedPlatforms().includes('vrbo') ? mixesPerRun * stays : 0;
    document.getElementById('sVolume').textContent = n
      ? `Creates ${n} saved search${n === 1 ? '' : 'es'} → about ${perDay} site search${perDay === 1 ? '' : 'es'} per run (~${Math.ceil((perDay * 45) / 60)} min).` +
        (rotating && mixes.length > 1 ? ` Guest mixes take turns, one per weekday run, so each mix is refreshed about every ${mixes.length} weekdays.` : '') +
        (perDay > 90 ? ' That is a long run - consider fewer days ahead or longer stays.' : '') +
        (vrbo > 6 ? ` That's ${vrbo} VRBO searches a day - more VRBO searches mean more bot checks, so consider fewer mixes there.` : '')
      : '';
  }

  document.getElementById('mixAddBtn').addEventListener('click', () => {
    const m = { adults: parseInt(adultsSel.value, 10), children: parseInt(kidsSel.value, 10) };
    if (!mixes.some((x) => mixKey(x) === mixKey(m))) mixes.push(m);
    mixes.sort((a, b) => a.adults + a.children - (b.adults + b.children) || a.children - b.children);
    renderMixes();
  });

  document.querySelectorAll('input[name="dateMode"]').forEach((r) => r.addEventListener('change', updateDateFields));
  document.querySelectorAll('[data-platform], #sWindows, #sNights, #sHorizon').forEach((i) => i.addEventListener('input', updateVolume));
  document.querySelectorAll('[data-platform]').forEach((i) => i.addEventListener('change', updateVolume));

  const openModal = () => {
    mixes = DEFAULT_MIXES.map((m) => ({ ...m }));
    renderMixes();
    updateDateFields();
    document.getElementById('sSaveStatus').textContent = '';
    modal.classList.remove('hidden');
    document.getElementById('sLabel').focus();
  };
  const closeModal = () => modal.classList.add('hidden');

  document.getElementById('addSearchBtn').addEventListener('click', openModal);
  document.getElementById('searchModalClose').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  function validatePlatformLocation(p) {
    const loc = locationFor(p);
    if (!loc) return `Enter a place name for ${platformLabel(p)}`;
    if (/^https?:\/\//i.test(loc)) {
      let host = '';
      try {
        host = new URL(loc).hostname;
      } catch {
        return `The ${platformLabel(p)} URL doesn't look valid`;
      }
      if (!host.includes(p === 'booking' ? 'booking.com' : p)) return `The URL in the ${platformLabel(p)} box is for ${host}`;
    }
    return null;
  }

  document.getElementById('sSaveBtn').addEventListener('click', async () => {
    const status = document.getElementById('sSaveStatus');
    const label = document.getElementById('sLabel').value.trim();
    const platforms = checkedPlatforms();
    const num = (id) => parseInt(document.getElementById(id).value, 10);
    const mode = dateMode();
    const checkin = document.getElementById('sCheckin').value;
    const checkout = document.getElementById('sCheckout').value;

    if (!label) return (status.textContent = 'Give the search a label');
    if (!platforms.length) return (status.textContent = 'Pick at least one platform');
    for (const p of platforms) {
      const problem = validatePlatformLocation(p);
      if (problem) return (status.textContent = problem);
    }
    if (!mixes.length) return (status.textContent = 'Add at least one guest mix');
    if (mode === 'fixed' && (!checkin || !checkout || checkout <= checkin)) {
      return (status.textContent = 'Pick a check-in and a later check-out');
    }

    status.textContent = 'Saving...';
    const rows = platforms.flatMap((platform) =>
      mixes.map((m) => ({
        platform,
        label,
        location: locationFor(platform),
        adults: m.adults,
        children: m.children,
        date_mode: mode,
        nights: mode === 'fixed' ? 2 : num('sNights'),
        open_windows: mode === 'open_dates' ? num('sWindows') : 1,
        horizon_days: mode === 'calendar' ? num('sHorizon') : 45,
        fixed_checkin: mode === 'fixed' ? checkin : null,
        fixed_checkout: mode === 'fixed' ? checkout : null,
        max_pages: num('sPages'),
      }))
    );
    const { error } = await db.from('rank_searches').insert(rows);
    if (error) {
      console.error(error);
      status.textContent = 'Save failed - check the numbers are in range';
      return;
    }
    status.textContent = 'Saved - it will be checked on the next tracker run';
    document.getElementById('sLabel').value = '';
    await loadAll();
    setTimeout(closeModal, 700);
  });

  try {
    if (localStorage.getItem('rankings.view') === 'calendar') currentView = 'calendar';
  } catch {}
  loadAll().then(() => setView(currentView));
})();
