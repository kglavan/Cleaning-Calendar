# Search Rankings

A standalone dashboard tool (`public/rankings.html`, `rankings.js`,
`rankings.css`, plus this `tracker/` folder). It does not modify the turnover
cleaning calendar. It reuses the calendar's data read-only:

- **Listings:** the same Supabase project and `public/config.js` (platform
  names and colors). The Airbnb listing id is read from the calendar's Airbnb
  iCal link.
- **Availability:** the `bookings` table the calendar syncs from all three
  iCal feeds. It's used only to pick open dates to search, never written.
- **Its own data:** the `rank_searches`, `rank_snapshots` and
  `rank_competitors` tables.

The **Rankings** page shows where the listing ranks in guest searches on
Airbnb, VRBO, and Booking.com, how that has trended, and what the page-1
competition looks like: price, rating, review count, and badges such as
Guest favorite, Discounted, Genius or Deal, and paid ads.

None of the three platforms offers an API for search position, so a small
tracker on your PC runs each saved search in a real browser once a day. Every
search gets a fresh incognito-style session, so results aren't shaped by past
visits. The tracker records where the listing appears and saves the result to
Supabase, and the Rankings page reads those results.

Each saved search is one platform plus one guest mix (adults + kids). Its
dates are either:
- **open dates**: the next few open stays of N nights on our calendar, using
  the bookings already synced from all three iCal feeds, spaced a week apart;
  or
- **specific dates**, e.g. Oct 28 – Nov 1.

The Rankings page shows each search label as a grid: guest mixes down the
side, platforms across the top, and your rank for each stay in every cell.

### Calendar view and suggested prices

The **Calendar** tab shows a month at a time. Booked nights come from the
calendar's `bookings` table. Each open night shows the page you land on for
each platform (A / V / B), taken from the latest check of the stay covering
that night. To fill it, add a search with **Every open night**: it splits each
open stretch in the next N days into stays of about the chosen length and
checks each one, so one guest mix across three platforms is about 30 searches
a day.

Below the calendar, each opening (weekly for long ones) gets a **suggested
all-in price per night** for each platform. The suggestion compares your price
with the page-1 listings for the same dates, preferring listings within one
bedroom of yours:

- top 5 on page 1: hold, or raise to the 40th percentile if you're cheaper
  than that;
- lower on page 1: don't sit above the median;
- not on page 1: move to the 40th percentile, or the 25th when check-in is
  under 10 days out;
- already cheaper than that and still not on page 1: hold, since price isn't
  the problem.

Prices are the all-in totals shown in search (including cleaning and service
fees). Since fees don't change with the rate, the suggested per-night change
is roughly the change to make to your nightly rate. This is a rule of thumb
built from search results, not a revenue-management model. Sanity-check it
against events and seasonality you know about.

Things to know:

- **Rankings are noisy.** Airbnb personalizes and shuffles results between
  sessions, so a single day's number can jump. Watch the trend line, not one
  reading.
- **The place name matters a lot.** Each site resolves a typed place
  differently. "Air Force Academy, CO" typed into an Airbnb URL misses the
  listing entirely, while "USAF Academy, CO" finds it. On Booking.com, "Air
  Force Academy" matches a single hotel, so use Monument there. The most
  faithful option is to run the search yourself in an incognito window and
  paste that page's URL as the place.
- **Not found usually means not bookable.** A listing outside its min-stay or
  max-guest rules for the searched dates is hidden from search.
- **VRBO often shows a "Bot or Not?" check.** When it appears, the tracker
  waits (3 min by default) for you to clear it in the Chrome window. It never
  tries to solve the check itself. If nobody clears it, that search is
  recorded as *Blocked*. Booking.com also needs a visible Chrome window.
  Airbnb runs hidden.
- Automated searching is against these sites' terms of use. The tracker is
  deliberately low-volume (one pass per day, with pauses), but a site can
  still rate-limit it.

## Setup

1. In the Supabase SQL Editor, run
   [`supabase/rank_tracker.sql`](supabase/rank_tracker.sql).
2. Install the tracker on the PC that will run it (it needs Google Chrome
   installed):

   ```bash
   cd tracker
   npm install
   npm run install-browser
   ```

3. Copy `tracker/.env.example` to `tracker/.env` and set the VRBO and
   Booking.com ids. The Supabase settings and the Airbnb id are read from the
   calendar's own `.env`, so they aren't repeated here.
4. Open the **Rankings** tab and click **Add Search**. Example: label "Air
   Force Academy", Airbnb "USAF Academy, CO", VRBO "US Air Force Academy",
   Booking.com "Monument, Colorado", a few guest mixes, and open dates of
   4-night stays. Check the plan without running anything:
   `node run.js --show-dates`.
5. Do a first run while watching:

   ```bash
   cd tracker
   npm run track
   ```

6. Schedule it for weekdays at 9am (runs only while you're logged in to Windows; pass -Time or -Days to change it):

   ```powershell
   cd tracker
   powershell -ExecutionPolicy Bypass -File .\schedule-task.ps1 -Time 9:00am
   ```

   Output goes to `tracker/tracker.log`.

To test a search without saving anything:

```bash
node run.js --dry-run --platform vrbo --location "US Air Force Academy" --checkin 2026-10-28 --checkout 2026-11-01 --adults 4 --id 4511668
```

The tracker lives in `tracker/` and is excluded from the Vercel deploy
(`.vercelignore`).
