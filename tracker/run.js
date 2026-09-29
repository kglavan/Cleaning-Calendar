// Runs every active saved search (rank_searches) on its platform, finds where
// our listing ranks, and saves the result plus the page-1 competitors to
// Supabase. Each search gets a fresh, incognito-style browser session (no
// cookies or history), so results aren't personalized to past visits.
//
//   npm run track                -> run all active searches, save to Supabase
//   node run.js --show-dates     -> print the stays each search would check, run nothing
//   node run.js --dry-run --platform airbnb --location "Air Force Academy, CO" \
//     --checkin 2026-10-28 --checkout 2026-11-01 --adults 2 --children 2 [--id 12345] [--pages 5]
//                                -> run one ad-hoc search, print results, save nothing
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import * as airbnb from './platforms/airbnb.js';
import * as vrbo from './platforms/vrbo.js';
import * as booking from './platforms/booking.js';
import { jitter } from './platforms/common.js';
import { staysForSearch, addDays, isoDay, oneStayPerWeek } from './dates.js';

// Settings come from the same .env the turnover calendar uses (Supabase
// project + the listing's iCal links), plus tracker/.env for anything the
// calendar doesn't know. tracker/.env wins where both set a value.
const HERE = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(HERE, '.env') });
dotenv.config({ path: path.join(HERE, '..', '.env') });

// The Airbnb listing id is part of the calendar's Airbnb iCal link
// (airbnb.com/calendar/ical/<id>.ics). VRBO and Booking.com iCal links
// don't contain their public property ids, so those are set in tracker/.env.
const airbnbIdFromIcal = (process.env.ICAL_URL_AIRBNB || '').match(/airbnb\.[^/]+\/calendar\/ical\/(\d+)/)?.[1];

const PLATFORMS = { airbnb, vrbo, booking };
const OUR_IDS = {
  airbnb: process.env.AIRBNB_LISTING_ID || airbnbIdFromIcal,
  vrbo: process.env.VRBO_LISTING_ID,
  booking: process.env.BOOKING_HOTEL_SLUG,
};
const HUMAN_WAIT_MS = Number(process.env.VRBO_HUMAN_WAIT_MINUTES ?? 3) * 60000;

const guestText = (s) => `${s.adults} adult${s.adults === 1 ? '' : 's'}${s.children ? ` + ${s.children} kid${s.children === 1 ? '' : 's'}` : ''}`;

// Airbnb works headless. Booking.com and VRBO need a visible Chrome window.
// Every search gets its own fresh context - the Playwright equivalent of a
// new incognito window - which is closed as soon as that search is done.
function openBrowsers() {
  let headless = null;
  let real = null;
  return {
    async freshPage(platform) {
      let browser;
      if (platform.needsRealBrowser) {
        real ??= await chromium.launch({ channel: 'chrome', headless: false });
        browser = real;
      } else {
        headless ??= await chromium.launch({ headless: process.env.HEADLESS !== 'false' });
        browser = headless;
      }
      const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1400, height: 1000 } });
      return ctx.newPage();
    },
    async close() {
      await real?.close().catch(() => {});
      await headless?.close().catch(() => {});
    },
  };
}

async function runSearch(browsers, search, { checkin, checkout }) {
  const platform = PLATFORMS[search.platform];
  const ourId = OUR_IDS[search.platform];
  const base = { checkin, checkout };
  const page = await browsers.freshPage(platform);

  try {
    const out = await platform.scrape(page, {
      search,
      checkin,
      checkout,
      url: platform.buildUrl(search, checkin, checkout),
      ourId,
      maxPages: search.max_pages,
      humanWaitMs: HUMAN_WAIT_MS,
    });
    if (out.status === 'blocked') {
      return { ...base, status: 'blocked', results: [], error: 'Site showed a bot check that was not cleared' };
    }
    const ours = out.results.find((r) => r.isOurs);
    return {
      ...base,
      status: ours ? 'found' : 'not_found',
      rank: ours?.position ?? null,
      page: ours?.page ?? null,
      pageSize: out.pageSize,
      resultsScanned: out.results.length,
      totalResults: out.totalResults,
      ourPrice: ours?.price ?? null,
      results: out.results,
      error: ourId ? null : `No listing id set for ${search.platform} in tracker/.env`,
    };
  } catch (err) {
    return { ...base, status: 'error', results: [], error: err.message.split('\n')[0] };
  } finally {
    await page.context().close().catch(() => {});
  }
}

async function saveSnapshot(db, search, r) {
  const { data: snap, error } = await db
    .from('rank_snapshots')
    .insert({
      search_id: search.id,
      checkin: r.checkin,
      checkout: r.checkout,
      status: r.status,
      rank: r.rank ?? null,
      page: r.page ?? null,
      page_size: r.pageSize ?? null,
      results_scanned: r.resultsScanned ?? 0,
      total_results: r.totalResults ?? null,
      our_price: r.ourPrice ?? null,
      error: r.error ?? null,
    })
    .select('id')
    .single();
  if (error) throw error;

  // Keep page 1 (the competition that matters) plus our own row wherever it landed.
  const keep = r.results.filter((x) => x.page === 1 || x.isOurs);
  if (keep.length === 0) return;
  const { error: compErr } = await db.from('rank_competitors').insert(
    keep.map((x) => ({
      snapshot_id: snap.id,
      position: x.position,
      page: x.page,
      listing_id: x.listingId,
      title: x.title,
      url: x.url,
      price: x.price,
      rating: x.rating,
      rating_scale: x.ratingScale,
      review_count: x.reviewCount,
      badges: x.badges,
      bedrooms: x.bedrooms ?? null,
      sleeps: x.sleeps ?? null,
      sponsored: x.sponsored,
      is_ours: x.isOurs,
    }))
  );
  if (compErr) throw compErr;
}

function describe(search, r) {
  const where = r.status === 'found' ? `#${r.rank} (page ${r.page})` : r.status.toUpperCase().replace('_', ' ');
  return `[${search.platform}] ${search.label} · ${guestText(search)} · ${r.checkin}→${r.checkout}: ${where} - scanned ${r.resultsScanned ?? 0}${r.error ? ` - ${r.error}` : ''}`;
}

// Spread lightly-searched platforms (those with minGapMs, i.e. VRBO) evenly
// through the run instead of doing them back to back at the end.
function interleave(jobs) {
  const spaced = jobs.filter((j) => PLATFORMS[j.search.platform].minGapMs);
  const rest = jobs.filter((j) => !PLATFORMS[j.search.platform].minGapMs);
  if (!spaced.length || !rest.length) return jobs;
  const out = [];
  const every = rest.length / spaced.length;
  let next = 0;
  rest.forEach((job, i) => {
    while (next < spaced.length && i >= Math.floor(next * every)) out.push(spaced[next++]);
    out.push(job);
  });
  while (next < spaced.length) out.push(spaced[next++]);
  return out;
}

// "Every open night" searches are expensive (one search per open stay), so
// runs take turns: each run checks the MIXES_PER_RUN guest mixes (label +
// adults + kids, across all platforms) whose latest results are oldest -
// never-checked mixes first. Other date modes are cheap and run every time.
// Pass --all to run everything.
async function pickRotation(db, searches) {
  const perRun = Number(process.env.MIXES_PER_RUN ?? 1);
  const calendar = searches.filter((s) => s.date_mode === 'calendar');
  const others = searches.filter((s) => s.date_mode !== 'calendar');
  if (!calendar.length || perRun <= 0) return others;

  const since = new Date(Date.now() - 60 * 86400000).toISOString();
  const { data: snaps, error } = await db
    .from('rank_snapshots')
    .select('search_id, run_at')
    .in('search_id', calendar.map((s) => s.id))
    .gte('run_at', since)
    .order('run_at', { ascending: false })
    .limit(5000);
  if (error) throw error;
  const lastRun = new Map();
  snaps.forEach((s) => {
    if (!lastRun.has(s.search_id)) lastRun.set(s.search_id, s.run_at);
  });

  const groups = new Map();
  calendar.forEach((s) => {
    const key = `${s.label}|${s.adults}|${s.children}`;
    const g = groups.get(key) ?? { key, searches: [], last: '' };
    g.searches.push(s);
    // A mix counts as fresh only when every platform in it has run.
    const t = lastRun.get(s.id) ?? '';
    g.last = g.searches.length === 1 ? t : t < g.last ? t : g.last;
    groups.set(key, g);
  });
  const chosen = [...groups.values()].sort((a, b) => (a.last < b.last ? -1 : a.last > b.last ? 1 : 0)).slice(0, perRun);
  chosen.forEach((g) => {
    const s = g.searches[0];
    console.log(`Rotation: ${s.label} · ${guestText(s)} (last checked ${g.last ? new Date(g.last).toLocaleDateString() : 'never'})`);
  });
  return [...others, ...chosen.flatMap((g) => g.searches)];
}

async function dryRun(browsers, args) {
  if (!PLATFORMS[args.platform] || !args.location) {
    throw new Error('--dry-run needs --platform airbnb|vrbo|booking and --location "City, ST"');
  }
  if (args.id) OUR_IDS[args.platform] = args.id;
  const checkin = args.checkin || addDays(isoDay(new Date()), 14);
  const checkout = args.checkout || addDays(checkin, 2);
  const search = {
    platform: args.platform,
    label: '(dry run)',
    location: args.location,
    adults: Number(args.adults),
    children: Number(args.children),
    max_pages: Number(args.pages),
  };
  const r = await runSearch(browsers, search, { checkin, checkout });
  console.table(
    r.results.map((x) => ({
      pos: x.position, pg: x.page, id: x.listingId, title: (x.title || '').slice(0, 40),
      price: x.price, br: x.bedrooms, rating: x.rating, reviews: x.reviewCount, badges: x.badges.join(', '),
      ad: x.sponsored ? 'Y' : '', ours: x.isOurs ? '<<<' : '',
    }))
  );
  console.log(describe(search, r), '| total:', r.totalResults, '| page size:', r.pageSize);
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      'show-dates': { type: 'boolean', default: false },
      platform: { type: 'string' },
      location: { type: 'string' },
      id: { type: 'string' },
      checkin: { type: 'string' },
      checkout: { type: 'string' },
      adults: { type: 'string', default: '2' },
      children: { type: 'string', default: '0' },
      pages: { type: 'string', default: '5' },
      all: { type: 'boolean', default: false },
    },
  });

  if (args['dry-run']) {
    const browsers = openBrowsers();
    try {
      await dryRun(browsers, args);
    } finally {
      await browsers.close();
    }
    return;
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in tracker/.env');
  }
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const [{ data: searches, error }, { data: bookings, error: bookErr }] = await Promise.all([
    db.from('rank_searches').select('*').eq('active', true).order('platform'),
    db.from('bookings').select('start_date, end_date').eq('cancelled', false).gte('end_date', isoDay(new Date())),
  ]);
  if (error) throw error;
  if (bookErr) throw bookErr;
  if (!searches.length) {
    console.log('No active searches - add some on the Rankings page.');
    return;
  }

  const toRun = args.all ? searches : await pickRotation(db, searches);
  const jobs = interleave(toRun.flatMap((search) => {
    let stays = staysForSearch(search, bookings);
    if (search.date_mode === 'calendar' && PLATFORMS[search.platform].oneStayPerWeek) stays = oneStayPerWeek(stays);
    return stays.map((stay) => ({ search, stay }));
  }));

  if (args['show-dates']) {
    for (const { search, stay } of jobs) {
      console.log(`[${search.platform}] ${search.label} · ${guestText(search)} · ${stay.checkin}→${stay.checkout}`);
    }
    console.log(`${jobs.length} search(es) would run.`);
    return;
  }

  const browsers = openBrowsers();
  try {
    console.log(`Running ${jobs.length} search(es) at ${new Date().toLocaleString()}`);
    // Once a platform's bot check has blocked this many searches in a row,
    // skip its remaining searches this run: more attempts just get blocked
    // (and each one waits for a human). Skipped searches aren't saved, so the
    // Rankings page keeps showing that platform's last good results.
    const maxBlocks = Number(process.env.MAX_CONSECUTIVE_BLOCKS ?? 2);
    const blockedInARow = {};
    const skipped = {};
    const lastRunAt = {};
    let ran = 0;
    for (const { search, stay } of jobs) {
      if (maxBlocks > 0 && (blockedInARow[search.platform] || 0) >= maxBlocks) {
        skipped[search.platform] = (skipped[search.platform] || 0) + 1;
        continue;
      }
      if (ran++ > 0) await jitter(8000, 20000);
      // Keep at least minGapMs between searches on a spaced-out platform.
      const gap = PLATFORMS[search.platform].minGapMs;
      const since = Date.now() - (lastRunAt[search.platform] || 0);
      if (gap && lastRunAt[search.platform] && since < gap) {
        console.log(`  waiting ${Math.round((gap - since) / 1000)}s before the next ${search.platform} search`);
        await new Promise((r) => setTimeout(r, gap - since));
      }
      lastRunAt[search.platform] = Date.now();
      const r = await runSearch(browsers, search, stay);
      console.log(describe(search, r));
      blockedInARow[search.platform] = r.status === 'blocked' ? (blockedInARow[search.platform] || 0) + 1 : 0;
      if (blockedInARow[search.platform] === maxBlocks) {
        console.log(`  ${search.platform}: ${maxBlocks} bot checks in a row - skipping its remaining searches this run`);
      }
      try {
        await saveSnapshot(db, search, r);
      } catch (err) {
        console.error(`  failed to save: ${err.message}`);
      }
    }
    for (const [platform, n] of Object.entries(skipped)) {
      console.log(`Skipped ${n} ${platform} search(es) after repeated bot checks - they'll be retried on the mix's next turn.`);
    }
  } finally {
    await browsers.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
