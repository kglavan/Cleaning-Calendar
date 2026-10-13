// Date logic shared by the Rankings page and the tracker: which nights are
// booked, where the open gaps are, and which stays each saved search checks.
// Plain script (no import/export) so the browser can load it with a <script>
// tag; the tracker imports it for its side effect and reads globalThis.RankDates.
(function () {
  // Never search a 1-night stay: the 25% promotion needs 2+ nights, and a
  // 1-night search doesn't show what guests booking a real stay see.
  const MIN_NIGHTS = 2;
  const nightsOf = (s) => Math.round((new Date(s.checkout + 'T00:00:00Z') - new Date(s.checkin + 'T00:00:00Z')) / 86400000);

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
  function openStays(bookings, { nights: wanted, count, leadDays = 2, horizonDays = 180, spacingDays = 7, today = isoDay(new Date()) }) {
    const nights = Math.max(wanted || MIN_NIGHTS, MIN_NIGHTS);
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

  // All stays a saved search should check on this run - never shorter than
  // MIN_NIGHTS.
  function staysForSearch(search, bookings, today = isoDay(new Date())) {
    return allStaysForSearch(search, bookings, today).filter((s) => nightsOf(s) >= MIN_NIGHTS);
  }

  function allStaysForSearch(search, bookings, today) {
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
  // open gap is cut into back-to-back stays; a leftover shorter than
  // MIN_NIGHTS is folded into the previous stay, and a gap shorter than
  // `nights` is searched whole (that's the stay a guest would actually book).
  // Gaps shorter than MIN_NIGHTS are skipped - they can't be booked as a
  // 2-night stay.
  function calendarStays(bookings, { nights: wanted, horizonDays = 45, leadDays = 1, today = isoDay(new Date()) }) {
    const nights = Math.max(wanted || MIN_NIGHTS, MIN_NIGHTS);
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
      while (s < gapEnd && nightsOf({ checkin: s, checkout: gapEnd }) >= MIN_NIGHTS) {
        let e = addDays(s, nights);
        // Fold a leftover too short to book on its own into this stay.
        if (e > gapEnd || nightsOf({ checkin: e, checkout: gapEnd }) < MIN_NIGHTS) e = gapEnd;
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

  // Monday of the week a date falls in - weeks run Monday to Sunday.
  function weekOf(iso) {
    const d = new Date(iso + 'T00:00:00Z');
    return addDays(iso, -((d.getUTCDay() + 6) % 7));
  }

  // Keep only the first stay that checks in during each Monday-Sunday week.
  // Used for platforms we sample lightly (VRBO), so each open week gets one
  // check instead of one per stay.
  function oneStayPerWeek(stays) {
    const seen = new Set();
    return stays.filter((s) => {
      const w = weekOf(s.checkin);
      if (seen.has(w)) return false;
      seen.add(w);
      return true;
    });
  }

  globalThis.RankDates = { MIN_NIGHTS, isoDay, addDays, bookedNights, openStays, calendarStays, openGaps, staysForSearch, weekOf, oneStayPerWeek };
})();
