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
import { staysForSearch, addDays, isoDay } from './dates.js';

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

  const jobs = searches.flatMap((search) => staysForSearch(search, bookings).map((stay) => ({ search, stay })));

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
    for (const [i, { search, stay }] of jobs.entries()) {
      if (i > 0) await jitter(8000, 20000);
      const r = await runSearch(browsers, search, stay);
      console.log(describe(search, r));
      try {
        await saveSnapshot(db, search, r);
      } catch (err) {
        console.error(`  failed to save: ${err.message}`);
      }
    }
  } finally {
    await browsers.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
