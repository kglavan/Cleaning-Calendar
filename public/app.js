(function () {
  const cfg = window.APP_CONFIG;
  const { createClient } = window.supabase;
  const db = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  const cleanerLabel = (id) => (cfg.CLEANERS.find((c) => c.id === id) || {}).label || '';

  let calendar;
  let currentBooking = null; // the booking currently open in the modal
  let currentBookings = []; // raw booking rows, kept in sync with the DB
  let currentCleaningWindows = [];
  let bookingsByUid = new Map();
  const dayCellBarRows = new Map(); // dateStr -> the bar-row element mounted in that day cell

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

  function addDaysStr(dateStr, n) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + n);
    return dt.toISOString().slice(0, 10);
  }

  function dateToLocalStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
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

  // For a given date, figure out what to show: either one full-width
  // segment (a mid-stay day) or three one-third segments (checkout /
  // cleaning / check-in), any of which may be empty.
  function getDaySegments(dateStr) {
    const midStay = currentBookings.find((b) => dateStr > b.start_date && dateStr < b.end_date);
    if (midStay) {
      return { full: { type: 'booking', booking: midStay } };
    }

    const checkout = currentBookings.find((b) => b.end_date === dateStr);
    const checkin = currentBookings.find((b) => b.start_date === dateStr);

    let left = checkout ? { type: 'booking', booking: checkout } : null;
    let mid = null;
    let right = checkin ? { type: 'booking', booking: checkin } : null;

    currentCleaningWindows
      .filter((w) => dateStr >= w.start_date && dateStr <= w.end_date)
      .forEach((w) => {
        const isStart = dateStr === w.start_date;
        const isEnd = dateStr === w.end_date;

        if (isStart) {
          if (!mid) mid = { type: 'cleaning', booking: w.booking };
          if (!isEnd && !checkin && !right) right = { type: 'cleaning', booking: w.booking };
        }
        if (isEnd) {
          if (!left) left = { type: 'cleaning', booking: w.booking };
          if (!mid) mid = { type: 'cleaning', booking: w.booking };
          if (!isStart && !checkin && !w.cappedByNextBooking && !right) {
            right = { type: 'cleaning', booking: w.booking };
          }
        }
        if (!isStart && !isEnd) {
          if (!left) left = { type: 'cleaning', booking: w.booking };
          if (!mid) mid = { type: 'cleaning', booking: w.booking };
          if (!right) right = { type: 'cleaning', booking: w.booking };
        }
      });

    return { left, mid, right };
  }

  function titleFor(b) {
    return `${cfg.SOURCE_LABELS[b.source] || b.source}${b.assigned_cleaner ? ' - ' + cleanerLabel(b.assigned_cleaner) : ''}`;
  }

  function makeSegmentDiv(segment, sizeClass) {
    const div = document.createElement('div');
    div.className = `turnover-seg turnover-seg-${sizeClass}`;
    if (!segment) {
      div.classList.add('turnover-seg-empty');
      return div;
    }
    div.dataset.bookingUid = segment.booking.uid;
    if (segment.type === 'booking') {
      div.classList.add('turnover-seg-booking');
      div.style.backgroundColor = cfg.SOURCE_COLORS[segment.booking.source] || '#888';
      div.title = titleFor(segment.booking);
    } else {
      div.classList.add('turnover-seg-cleaning');
      if (segment.booking.status === 'complete') div.classList.add('turnover-seg-complete');
      div.title = 'Cleaning' + (segment.booking.assigned_cleaner ? ' - ' + cleanerLabel(segment.booking.assigned_cleaner) : '');
    }
    return div;
  }

  function renderBarRow(dateStr, barRow) {
    barRow.innerHTML = '';
    const seg = getDaySegments(dateStr);
    if (seg.full) {
      barRow.appendChild(makeSegmentDiv(seg.full, 'full'));
    } else {
      barRow.appendChild(makeSegmentDiv(seg.left, 'third'));
      barRow.appendChild(makeSegmentDiv(seg.mid, 'third'));
      barRow.appendChild(makeSegmentDiv(seg.right, 'third'));
    }
  }

  function dayCellDidMount(arg) {
    const dateStr = dateToLocalStr(arg.date);
    const barRow = document.createElement('div');
    barRow.className = 'turnover-bar-row';
    barRow.addEventListener('click', (e) => {
      const target = e.target.closest('[data-booking-uid]');
      if (!target) return;
      const booking = bookingsByUid.get(target.dataset.bookingUid);
      if (booking) openModal(booking);
    });
    arg.el.appendChild(barRow);
    dayCellBarRows.set(dateStr, barRow);
    renderBarRow(dateStr, barRow);
  }

  function dayCellWillUnmount(arg) {
    dayCellBarRows.delete(dateToLocalStr(arg.date));
  }

  function renderEventContent(arg) {
    const p = arg.event.extendedProps;
    const wrap = document.createElement('div');

    const statusDot = document.createElement('span');
    statusDot.className = 'status-dot' + (p.status === 'complete' ? ' complete' : '');
    wrap.appendChild(statusDot);

    const label = document.createElement('span');
    label.textContent = `${cfg.SOURCE_LABELS[p.source] || p.source}`;
    wrap.appendChild(label);

    if (p.assigned_cleaner) {
      const tag = document.createElement('div');
      tag.className = 'cleaner-tag';
      tag.textContent = cleanerLabel(p.assigned_cleaner);
      wrap.appendChild(tag);
    }

    return { domNodes: [wrap] };
  }

  async function refreshCalendar() {
    currentBookings = await fetchBookingsRaw();
    currentCleaningWindows = computeCleaningWindows(currentBookings);
    bookingsByUid = new Map(currentBookings.map((b) => [b.uid, b]));

    // Kept only so the list view (a plain agenda list, not a bar grid) has
    // something to render - it's hidden everywhere else via eventDidMount.
    const listEvents = currentBookings.map((b) => ({
      id: b.uid,
      title: b.summary || cfg.SOURCE_LABELS[b.source] || b.source,
      start: b.start_date,
      end: b.end_date,
      allDay: true,
      backgroundColor: cfg.SOURCE_COLORS[b.source] || '#888',
      borderColor: cfg.SOURCE_COLORS[b.source] || '#888',
      extendedProps: { ...b },
    }));
    calendar.removeAllEvents();
    calendar.addEventSource(listEvents);

    dayCellBarRows.forEach((barRow, dateStr) => renderBarRow(dateStr, barRow));
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
      dayCellDidMount,
      dayCellWillUnmount,
      eventContent: renderEventContent,
      eventDidMount: (info) => {
        // The bar-grid views get their own custom thirds-based bars
        // (see dayCellDidMount); FullCalendar's own event bars would
        // just duplicate them, so hide them there. List view still
        // shows the normal event rows.
        if (info.view.type.indexOf('dayGrid') === 0) {
          info.el.style.display = 'none';
        }
      },
      eventClick: (info) => {
        const booking = bookingsByUid.get(info.event.id);
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
      const result = await res.json();
      const parts = [`${result.synced} synced`];
      if (result.cancelled) parts.push(`${result.cancelled} cancelled`);
      if (result.errors && result.errors.length) parts.push(`${result.errors.length} error(s)`);
      statusEl.textContent = parts.join(', ');
      if (result.errors && result.errors.length) console.error(result.errors);
    } catch (err) {
      statusEl.textContent = 'Sync failed';
      console.error(err);
    }
    await refreshCalendar();
  });

  // ---------- Init ----------

  initCalendar();
})();
