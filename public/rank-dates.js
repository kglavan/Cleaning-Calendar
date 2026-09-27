// Date logic shared by the Rankings page and the tracker: which nights are
// booked, where the open gaps are, and which stays each saved search checks.
// Plain script (no import/export) so the browser can load it with a <script>
// tag; the tracker imports it for its side effect and reads globalThis.RankDates.
(function () {
  function isoDay(date) {
    return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())).toISOString().slice(0, 10);
  }

  function addDays(iso, n) {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // Nights that are taken, from the bookings table (iCal feeds from all three
  // platforms, including owner blocks). end_date is the checkout day, so the
  // booked nights are start_date .. end_date - 1.
  function bookedNights(bookings) {
    const nights = new Set();
    for (const b of bookings) {
      for (let d = b.start_date; d < b.end_date; d = addDays(d, 1)) nights.add(d);
    }
    return nights;
  }

  // The soonest `count` stays of `nights` nights that are fully open on our
  // calendar, at least `leadDays` out and at least `spacingDays` apart so they
  // land in different weeks instead of all piling into the same open gap.
  function openStays(bookings, { nights, count, leadDays = 2, horizonDays = 180, spacingDays = 7, today = isoDay(new Date()) }) {
    const taken = bookedNights(bookings);
    const stays = [];
    const last = addDays(today, horizonDays);
    let start = addDays(today, leadDays);
    while (stays.length < count && start <= last) {
      let open = true;
      for (let i = 0; i < nights; i++) {
        if (taken.has(addDays(start, i))) {
          open = false;
          break;
        }
      }
      if (open) {
        stays.push({ checkin: start, checkout: addDays(start, nights) });
        start = addDays(start, Math.max(nights, spacingDays));
      } else {
        start = addDays(start, 1);
      }
    }
    return stays;
  }

  // All stays a saved search should check on this run.
  function staysForSearch(search, bookings, today = isoDay(new Date())) {
    if (search.date_mode === 'fixed') {
      if (!search.fixed_checkin || !search.fixed_checkout || search.fixed_checkin < today) return [];
      return [{ checkin: search.fixed_checkin, checkout: search.fixed_checkout }];
    }
    if (search.date_mode === 'offset') {
      const checkin = addDays(today, search.checkin_offset_days);
      return [{ checkin, checkout: addDays(checkin, search.nights) }];
    }
    if (search.date_mode === 'calendar') {
      return calendarStays(bookings, { nights: search.nights, horizonDays: search.horizon_days || 45, today });
    }
    return openStays(bookings, { nights: search.nights, count: search.open_windows || 2, today });
  }

  // Every open night in the next `horizonDays`, split into stays of about
  // `nights` nights, so the calendar view has a rank for each open day. Each
  // open gap is cut into back-to-back stays; a leftover of one night is folded
  // into the previous stay, and a gap shorter than `nights` is searched whole
  // (that's the stay a guest would actually book).
  function calendarStays(bookings, { nights, horizonDays = 45, leadDays = 1, today = isoDay(new Date()) }) {
    const taken = bookedNights(bookings);
    const stays = [];
    const first = addDays(today, leadDays);
    const end = addDays(today, horizonDays);
    let d = first;
    while (d < end) {
      if (taken.has(d)) {
        d = addDays(d, 1);
        continue;
      }
      let gapEnd = d; // exclusive: first taken night or end of horizon
      while (gapEnd < end && !taken.has(gapEnd)) gapEnd = addDays(gapEnd, 1);
      let s = d;
      while (s < gapEnd) {
        let e = addDays(s, nights);
        if (e > gapEnd || addDays(e, 1) === gapEnd) e = gapEnd; // fold a 1-night leftover in
        stays.push({ checkin: s, checkout: e });
        s = e;
      }
      d = gapEnd;
    }
    return stays;
  }

  // Maximal runs of open nights from `from` up to (not including) `until`.
  function openGaps(bookings, from, until) {
    const taken = bookedNights(bookings);
    const gaps = [];
    let d = from;
    while (d < until) {
      if (taken.has(d)) {
        d = addDays(d, 1);
        continue;
      }
      const start = d;
      while (d < until && !taken.has(d)) d = addDays(d, 1);
      gaps.push({ start, end: d }); // end = first night that's not part of the gap
    }
    return gaps;
  }

  globalThis.RankDates = { isoDay, addDays, bookedNights, openStays, calendarStays, openGaps, staysForSearch };
})();
