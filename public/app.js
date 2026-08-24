(function () {
  const cfg = window.APP_CONFIG;
  const { createClient } = window.supabase;
  const db = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  const cleanerLabel = (id) => (cfg.CLEANERS.find((c) => c.id === id) || {}).label || '';

  let calendar;
  let currentBooking = null; // the booking currently open in the modal
  let bookingsByUid = new Map();

  // ---------- Calendar ----------

  async function fetchBookingsRaw() {
    const { data, error } = await db
      .from('bookings')
      .select('*')
      .eq('cancelled', false);

    if (error) {
      console.error('Failed to load bookings', error);
      return [];
    }
    return data;
  }

  async function fetchUnavailabilityRaw() {
    const { data, error } = await db
      .from('cleaner_unavailability')
      .select('*')
      .order('start_date', { ascending: true });

    if (error) {
      console.error('Failed to load cleaner unavailability', error);
      return [];
    }
    return data;
  }

  function addDaysStr(dateStr, n) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + n);
    return dt.toISOString().slice(0, 10);
  }

  // A cleaning window runs from a booking's checkout day until whichever
  // comes first: the next booking's check-in, or 3 days after checkout.
  function computeCleaningWindows(bookings) {
    const sorted = [...bookings].sort((a, b) =>
      a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : 0
    );

    return sorted.map((b, i) => {
      const next = sorted.slice(i + 1).find((n) => n.start_date >= b.end_date);
      const capDate = addDaysStr(b.end_date, 3);
      const cappedByNextBooking = !!next && next.start_date < capDate;
      return {
        booking: b,
        start_date: b.end_date,
        end_date: cappedByNextBooking ? next.start_date : capDate,
        cappedByNextBooking,
      };
    });
  }

  function renderEventContent(arg) {
    const p = arg.event.extendedProps;
    if (p.kind === 'unavailability') return renderUnavailabilityEventContent(arg);

    const wrap = document.createElement('div');
    wrap.className = 'event-inner';

    if (p.kind === 'cleaning') {
      const statusDot = document.createElement('span');
      statusDot.className = 'status-dot' + (p.booking.status === 'complete' ? ' complete' : '');
      wrap.appendChild(statusDot);

      const label = document.createElement('span');
      label.textContent = 'Cleaning';
      wrap.appendChild(label);
      if (p.booking.assigned_cleaner) {
        const tag = document.createElement('div');
        tag.className = 'cleaner-tag';
        tag.textContent = cleanerLabel(p.booking.assigned_cleaner);
        wrap.appendChild(tag);
      }
      return { domNodes: [wrap] };
    }

    const statusDot = document.createElement('span');
    statusDot.className = 'status-dot' + (p.status === 'complete' ? ' complete' : '');
    wrap.appendChild(statusDot);

    const label = document.createElement('span');
    label.textContent = cfg.SOURCE_LABELS[p.source] || p.source;
    wrap.appendChild(label);

    return { domNodes: [wrap] };
  }

  function renderUnavailabilityEventContent(arg) {
    const p = arg.event.extendedProps;
    const wrap = document.createElement('div');
    wrap.className = 'event-inner';
    const label = document.createElement('span');
    label.textContent = `${cleanerLabel(p.cleaner)}${p.reason ? ' - ' + p.reason : ' - Unavailable'}`;
    wrap.appendChild(label);
    return { domNodes: [wrap] };
  }

  // Bars span the real multi-day range as ONE continuous FullCalendar
  // event, but a booking's check-in/checkout day (and a cleaning window's
  // end, if a real next booking reserves that day's check-in) should only
  // show a third of that day. Rather than touch the harness's own
  // left/right (which controls which day-columns it spans, and isn't a
  // plain "% of container" the way it might look), we inset the inner
  // bar with margins sized against the harness's actual rendered width -
  // that can't corrupt FullCalendar's own column-span layout.
  function eventDidMount(info) {
    if (info.view.type.indexOf('dayGrid') !== 0) return;
    if (!info.isStart && !info.isEnd) return;

    const p = info.event.extendedProps;
    if (p.kind !== 'booking' && p.kind !== 'cleaning') return;

    const startFrac = p.kind === 'booking' ? 2 / 3 : 1 / 3;
    const endFrac = p.kind === 'booking' ? 2 / 3 : p.cappedByNextBooking ? 1 / 3 : 0;
    if (!(info.isStart && startFrac > 0) && !(info.isEnd && endFrac > 0)) return;

    const harness = info.el.closest('.fc-daygrid-event-harness');
    const dayFrame = document.querySelector('.fc-daygrid-day-frame');
    if (!harness || !dayFrame) return;

    const colWidth = dayFrame.getBoundingClientRect().width;
    const harnessWidth = harness.getBoundingClientRect().width;
    if (!colWidth || !harnessWidth) return;
    const numDays = Math.max(1, Math.round(harnessWidth / colWidth));
    const oneDayPct = 100 / numDays;

    const leftPct = info.isStart ? oneDayPct * startFrac : 0;
    const rightPct = info.isEnd ? oneDayPct * endFrac : 0;

    info.el.style.marginLeft = leftPct + '%';
    info.el.style.marginRight = rightPct + '%';
    info.el.style.width = `calc(100% - ${leftPct + rightPct}%)`;
  }

  async function refreshCalendar() {
    const [bookings, unavailability] = await Promise.all([
      fetchBookingsRaw(),
      fetchUnavailabilityRaw(),
    ]);
    const cleaningWindows = computeCleaningWindows(bookings);
    bookingsByUid = new Map(bookings.map((b) => [b.uid, b]));

    const bookingEvents = bookings.map((b) => ({
      id: b.uid,
      title: cfg.SOURCE_LABELS[b.source] || b.source,
      start: b.start_date,
      end: addDaysStr(b.end_date, 1),
      allDay: true,
      backgroundColor: cfg.SOURCE_COLORS[b.source] || '#888',
      borderColor: cfg.SOURCE_COLORS[b.source] || '#888',
      extendedProps: { ...b, kind: 'booking', bookingUid: b.uid },
    }));

    const cleaningEvents = cleaningWindows.map((w) => {
      const cleanerColor = w.booking.assigned_cleaner ? cfg.CLEANER_COLORS[w.booking.assigned_cleaner] : null;
      return {
        id: `cleaning:${w.booking.uid}`,
        title: 'Cleaning',
        start: w.start_date,
        end: addDaysStr(w.end_date, 1),
        allDay: true,
        ...(cleanerColor ? { backgroundColor: cleanerColor, borderColor: cleanerColor } : {}),
        classNames: ['fc-cleaning-event'].concat(cleanerColor ? ['fc-cleaning-assigned'] : []),
        extendedProps: { kind: 'cleaning', booking: w.booking, bookingUid: w.booking.uid, cappedByNextBooking: w.cappedByNextBooking },
      };
    });

    const unavailabilityEvents = unavailability.map((u) => ({
      id: `unavail:${u.id}`,
      title: cleanerLabel(u.cleaner),
      start: u.start_date,
      end: addDaysStr(u.end_date, 1),
      allDay: true,
      classNames: ['fc-unavailable-event'],
      extendedProps: { kind: 'unavailability', ...u },
    }));

    calendar.removeAllEvents();
    calendar.addEventSource([...bookingEvents, ...cleaningEvents, ...unavailabilityEvents]);
  }

  function initCalendar() {
    const el = document.getElementById('calendar');
    calendar = new FullCalendar.Calendar(el, {
      initialView: 'dayGridMonth',
      height: 'auto',
      headerToolbar: {
        left: 'prev,next today',
        center: 'title',
        right: 'dayGridMonth,dayGridWeek,listMonth',
      },
      eventContent: renderEventContent,
      eventDidMount,
      eventClick: (info) => {
        const p = info.event.extendedProps;
        if (p.kind === 'unavailability') {
          openUnavailModal(p);
          return;
        }
        const booking = bookingsByUid.get(p.bookingUid);
        if (booking) openModal(booking);
      },
    });
    calendar.render();
    refreshCalendar();
  }

  // ---------- Modal ----------

  const overlay = document.getElementById('modalOverlay');
  const cleanerSelect = document.getElementById('assignedCleaner');
  const checklistEl = document.getElementById('checklistItems');

  cfg.CLEANERS.forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.label;
    cleanerSelect.appendChild(opt);
  });

  function buildChecklist(state) {
    checklistEl.innerHTML = '';
    cfg.CHECKLIST_ITEMS.forEach((item) => {
      const li = document.createElement('li');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = `chk_${item.id}`;
      checkbox.checked = !!state[item.id];
      const label = document.createElement('label');
      label.htmlFor = checkbox.id;
      label.textContent = item.label;
      li.appendChild(checkbox);
      li.appendChild(label);
      checklistEl.appendChild(li);
    });
  }

  function readChecklist() {
    const state = {};
    cfg.CHECKLIST_ITEMS.forEach((item) => {
      const checkbox = document.getElementById(`chk_${item.id}`);
      state[item.id] = !!checkbox.checked;
    });
    return state;
  }

  async function openModal(booking) {
    currentBooking = booking;

    document.getElementById('modalTitle').textContent =
      booking.summary || cfg.SOURCE_LABELS[booking.source] || booking.source;
    document.getElementById('modalDates').textContent =
      `${booking.start_date} → ${booking.end_date} (${cfg.SOURCE_LABELS[booking.source] || booking.source})`;

    cleanerSelect.value = booking.assigned_cleaner || '';
    document.getElementById('nextGuestCount').value =
      booking.next_guest_count === null || booking.next_guest_count === undefined
        ? ''
        : booking.next_guest_count;
    document.getElementById('statusComplete').checked = booking.status === 'complete';
    document.getElementById('notes').value = booking.notes || '';
    document.getElementById('saveStatus').textContent = '';
    document.getElementById('issueDescription').value = '';
    document.getElementById('issuePhotoInput').value = '';
    document.getElementById('proofPhotoInput').value = '';

    buildChecklist(booking.checklist_state || {});

    overlay.classList.remove('hidden');

    await Promise.all([loadProofPhotos(booking.uid), loadIssues(booking.uid)]);
  }

  function closeModal() {
    overlay.classList.add('hidden');
    currentBooking = null;
  }

  document.getElementById('modalClose').addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  document.getElementById('saveBtn').addEventListener('click', async () => {
    if (!currentBooking) return;
    const saveStatus = document.getElementById('saveStatus');
    saveStatus.textContent = 'Saving...';

    const { error } = await db.rpc('update_booking', {
      p_uid: currentBooking.uid,
      p_assigned_cleaner: cleanerSelect.value || null,
      p_status: document.getElementById('statusComplete').checked ? 'complete' : 'pending',
      p_notes: document.getElementById('notes').value || null,
      p_next_guest_count: document.getElementById('nextGuestCount').value === ''
        ? null
        : parseInt(document.getElementById('nextGuestCount').value, 10),
      p_checklist_state: readChecklist(),
    });

    if (error) {
      console.error(error);
      saveStatus.textContent = 'Save failed - try again';
      return;
    }

    saveStatus.textContent = 'Saved';
    await refreshCalendar();
  });

  // ---------- Photos ----------

  async function uploadPhoto(file, bookingUid, subfolder) {
    const path = `${bookingUid}/${subfolder}/${Date.now()}-${file.name}`;
    const { error: uploadError } = await db.storage
      .from('cleaning-photos')
      .upload(path, file);
    if (uploadError) throw uploadError;

    const { data } = db.storage.from('cleaning-photos').getPublicUrl(path);
    return data.publicUrl;
  }

  async function loadProofPhotos(bookingUid) {
    const grid = document.getElementById('proofPhotos');
    grid.innerHTML = '';
    const { data, error } = await db
      .from('booking_photos')
      .select('*')
      .eq('booking_uid', bookingUid)
      .eq('kind', 'proof')
      .order('created_at', { ascending: true });
    if (error) {
      console.error(error);
      return;
    }
    data.forEach((p) => {
      const img = document.createElement('img');
      img.src = p.photo_url;
      grid.appendChild(img);
    });
  }

  document.getElementById('proofPhotoInput').addEventListener('change', async (e) => {
    if (!currentBooking) return;
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      try {
        const url = await uploadPhoto(file, currentBooking.uid, 'proof');
        await db.from('booking_photos').insert({
          booking_uid: currentBooking.uid,
          kind: 'proof',
          photo_url: url,
        });
      } catch (err) {
        console.error('Photo upload failed', err);
      }
    }
    e.target.value = '';
    await loadProofPhotos(currentBooking.uid);
  });

  // ---------- Issues ----------

  async function loadIssues(bookingUid) {
    const list = document.getElementById('issuesList');
    list.innerHTML = '';
    const { data, error } = await db
      .from('issues')
      .select('*')
      .eq('booking_uid', bookingUid)
      .order('created_at', { ascending: false });
    if (error) {
      console.error(error);
      return;
    }

    data.forEach((issue) => {
      const item = document.createElement('div');
      item.className = 'issue-item' + (issue.resolved ? ' resolved' : '');

      const desc = document.createElement('div');
      desc.textContent = issue.description;
      item.appendChild(desc);

      if (issue.photo_url) {
        const img = document.createElement('img');
        img.src = issue.photo_url;
        item.appendChild(img);
      }

      const resolveLabel = document.createElement('label');
      resolveLabel.style.display = 'block';
      resolveLabel.style.marginTop = '6px';
      const resolveCheckbox = document.createElement('input');
      resolveCheckbox.type = 'checkbox';
      resolveCheckbox.checked = issue.resolved;
      resolveCheckbox.addEventListener('change', async () => {
        await db.rpc('set_issue_resolved', {
          p_issue_id: issue.id,
          p_resolved: resolveCheckbox.checked,
        });
        await loadIssues(bookingUid);
      });
      resolveLabel.appendChild(resolveCheckbox);
      resolveLabel.appendChild(document.createTextNode(' Resolved'));
      item.appendChild(resolveLabel);

      list.appendChild(item);
    });
  }

  document.getElementById('reportIssueBtn').addEventListener('click', async () => {
    if (!currentBooking) return;
    const description = document.getElementById('issueDescription').value.trim();
    if (!description) return;

    const fileInput = document.getElementById('issuePhotoInput');
    let photoUrl = null;
    if (fileInput.files && fileInput.files[0]) {
      try {
        photoUrl = await uploadPhoto(fileInput.files[0], currentBooking.uid, 'issue');
      } catch (err) {
        console.error('Issue photo upload failed', err);
      }
    }

    const { error } = await db.from('issues').insert({
      booking_uid: currentBooking.uid,
      description,
      photo_url: photoUrl,
    });
    if (error) {
      console.error(error);
      return;
    }

    document.getElementById('issueDescription').value = '';
    fileInput.value = '';
    await loadIssues(currentBooking.uid);
  });

  // ---------- Sync ----------

  document.getElementById('syncNowBtn').addEventListener('click', async () => {
    const statusEl = document.getElementById('syncStatus');
    statusEl.textContent = 'Syncing...';
    try {
      const res = await fetch('/api/sync');
      const bodyText = await res.text();
      let result;
      try {
        result = JSON.parse(bodyText);
      } catch (parseErr) {
        console.error('Sync response was not JSON:', res.status, bodyText.slice(0, 500));
        statusEl.textContent = `Sync failed (HTTP ${res.status} - see console)`;
        await refreshCalendar();
        return;
      }

      if (result.error) {
        console.error('Sync error:', result.error);
        statusEl.textContent = `Sync failed: ${result.error}`;
        await refreshCalendar();
        return;
      }

      const parts = [`${result.synced} synced`];
      if (result.cancelled) parts.push(`${result.cancelled} cancelled`);
      if (result.errors && result.errors.length) parts.push(`${result.errors.length} error(s)`);
      statusEl.textContent = parts.join(', ');
      if (result.errors && result.errors.length) console.error(result.errors);
    } catch (err) {
      statusEl.textContent = `Sync failed: ${err.message}`;
      console.error(err);
    }
    await refreshCalendar();
  });

  // ---------- Cleaner unavailability ----------

  const unavailOverlay = document.getElementById('unavailModalOverlay');
  const unavailCleanerSelect = document.getElementById('unavailCleaner');

  cfg.CLEANERS.forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.label;
    unavailCleanerSelect.appendChild(opt);
  });

  async function loadUnavailList() {
    const list = document.getElementById('unavailList');
    list.innerHTML = '';
    const rows = await fetchUnavailabilityRaw();

    if (rows.length === 0) {
      list.textContent = 'No unavailability on record.';
      return;
    }

    rows.forEach((u) => {
      const item = document.createElement('div');
      item.className = 'issue-item';

      const desc = document.createElement('span');
      desc.textContent = `${cleanerLabel(u.cleaner)}: ${u.start_date} to ${u.end_date}${u.reason ? ' (' + u.reason + ')' : ''}`;
      item.appendChild(desc);

      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-warning';
      delBtn.style.marginLeft = '8px';
      delBtn.textContent = 'Remove';
      delBtn.addEventListener('click', async () => {
        await db.from('cleaner_unavailability').delete().eq('id', u.id);
        await loadUnavailList();
        await refreshCalendar();
      });
      item.appendChild(delBtn);

      list.appendChild(item);
    });
  }

  function openUnavailModal(prefill) {
    document.getElementById('unavailSaveStatus').textContent = '';
    unavailCleanerSelect.value = prefill ? prefill.cleaner : cfg.CLEANERS[0].id;
    document.getElementById('unavailStart').value = prefill ? prefill.start_date : '';
    document.getElementById('unavailEnd').value = prefill ? prefill.end_date : '';
    document.getElementById('unavailReason').value = prefill ? prefill.reason || '' : '';
    unavailOverlay.classList.remove('hidden');
    loadUnavailList();
  }

  function closeUnavailModal() {
    unavailOverlay.classList.add('hidden');
  }

  document.getElementById('markUnavailableBtn').addEventListener('click', () => openUnavailModal(null));
  document.getElementById('unavailModalClose').addEventListener('click', closeUnavailModal);
  unavailOverlay.addEventListener('click', (e) => {
    if (e.target === unavailOverlay) closeUnavailModal();
  });

  document.getElementById('unavailSaveBtn').addEventListener('click', async () => {
    const statusEl = document.getElementById('unavailSaveStatus');
    const cleaner = unavailCleanerSelect.value;
    const start = document.getElementById('unavailStart').value;
    const end = document.getElementById('unavailEnd').value;
    const reason = document.getElementById('unavailReason').value.trim() || null;

    if (!start || !end) {
      statusEl.textContent = 'Start and end dates are required';
      return;
    }
    if (end < start) {
      statusEl.textContent = 'End date must be on or after start date';
      return;
    }

    statusEl.textContent = 'Saving...';
    const { error } = await db.from('cleaner_unavailability').insert({
      cleaner,
      start_date: start,
      end_date: end,
      reason,
    });

    if (error) {
      console.error(error);
      statusEl.textContent = 'Save failed - try again';
      return;
    }

    statusEl.textContent = 'Added';
    document.getElementById('unavailStart').value = '';
    document.getElementById('unavailEnd').value = '';
    document.getElementById('unavailReason').value = '';
    await loadUnavailList();
    await refreshCalendar();
  });

  // ---------- Init ----------

  cfg.CLEANERS.forEach((c) => {
    const item = document.createElement('span');
    item.className = 'legend-item';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = cfg.CLEANER_COLORS[c.id] || '#888';
    item.appendChild(dot);
    item.appendChild(document.createTextNode(c.label));
    document.getElementById('cleanerLegend').appendChild(item);
  });

  initCalendar();
})();
