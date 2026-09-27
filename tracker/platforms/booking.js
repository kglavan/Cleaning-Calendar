import { parseMoney, parseCount, scrollThrough, findBadges, jitter, pastedSearchUrl, CHILD_AGE, parseCapacity } from './common.js';

export const key = 'booking';
// Booking.com strips the search from headless browsers, so it uses the visible Chrome window too.
export const needsRealBrowser = true;

const PAGE_SIZE = 25;

export function buildUrl(search, checkin, checkout, offset = 0) {
  const children = search.children || 0;
  const pasted = pastedSearchUrl(search.location, /(^|.)booking.com$/i);
  const url = pasted || new URL('https://www.booking.com/searchresults.html');
  for (const p of ['checkin_year', 'checkin_month', 'checkin_monthday', 'checkout_year', 'checkout_month', 'checkout_monthday', 'srpvid', 'age']) {
    url.searchParams.delete(p);
  }
  if (!pasted) url.searchParams.set('ss', search.location);
  url.searchParams.set('checkin', checkin);
  url.searchParams.set('checkout', checkout);
  url.searchParams.set('group_adults', String(search.adults));
  url.searchParams.set('group_children', String(children));
  for (let i = 0; i < children; i++) url.searchParams.append('age', String(CHILD_AGE));
  url.searchParams.set('no_rooms', '1');
  url.searchParams.set('lang', 'en-us');
  url.searchParams.set('selected_currency', 'USD');
  url.searchParams.set('offset', String(offset));
  return url.toString();
}

// Our Booking.com id is the slug in https://www.booking.com/hotel/us/<slug>.html
export function slugFromUrl(href) {
  const m = (href || '').match(/\/hotel\/[a-z]{2}\/([^./?]+)/i);
  return m ? m[1].toLowerCase() : null;
}

export function isOurs(listingId, ourId) {
  return !!ourId && String(listingId) === String(ourId).trim().toLowerCase();
}

const BADGES = ['Genius', 'Preferred', 'Getaway Deal', 'Limited-time Deal', 'Early 2026 Deal', 'Late Escape Deal', 'New to Booking.com', 'Free cancellation'];

async function readCards(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="property-card"]')].map((card) => ({
      href: card.querySelector('a[data-testid="title-link"]')?.href || '',
      title: card.querySelector('[data-testid="title"]')?.innerText || null,
      priceText: card.querySelector('[data-testid="price-and-discounted-price"]')?.innerText || '',
      scoreText: card.querySelector('[data-testid="review-score"]')?.innerText || '',
      text: card.innerText,
    }))
  );
}

function parseCard(c) {
  const slug = slugFromUrl(c.href);
  let hapos = null;
  try {
    hapos = Number(new URL(c.href).searchParams.get('hapos')) || null;
  } catch {}
  const score = c.scoreText.match(/Scored\s+([\d.]+)/i) || c.scoreText.match(/^([\d.]+)/m);
  const reviews = c.scoreText.match(/([\d,]+)\s+reviews?/i);
  return {
    listingId: slug,
    title: c.title,
    url: slug ? c.href.split('?')[0] : null,
    hapos,
    price: stayTotal(c),
    rating: score ? Number(score[1]) : null,
    ratingScale: 10,
    reviewCount: reviews ? parseCount(reviews[1]) : null,
    badges: findBadges(c.text, BADGES).concat(/Original price \$/i.test(c.text) ? ['Discounted'] : []),
    sponsored: /\bAd\b|Sponsored/.test(c.text.split('\n').slice(0, 3).join(' ')),
    ...parseCapacity(c.text),
  };
}

// The card shows "Per night $117" next to the stay total, and discounted
// cards show both "Original price $849" and "Current price $717". We want
// the current total for the whole stay.
function stayTotal(c) {
  const current = c.text.match(/Current price \$\s?([\d,]+)/i) || c.text.match(/(?:^|\n)Price \$\s?([\d,]+)/i);
  if (current) return Number(current[1].replace(/,/g, ''));
  const amounts = c.priceText.replace(/Per night\s*\$[\d,]+/i, '').match(/\$[\d,]+/g) || [];
  return amounts.length ? parseMoney(amounts[amounts.length - 1]) : null;
}

export async function scrape(page, { search, checkin, checkout, ourId, maxPages }) {
  const results = [];
  const seen = new Set();
  let pageSize = null;
  let totalResults = null;

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    const url = buildUrl(search, checkin, checkout, (pageNum - 1) * PAGE_SIZE);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const gotCards = await page
      .waitForSelector('[data-testid="property-card"]', { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (!gotCards) break;
    if (pageNum === 1) {
      totalResults = await page.locator('h1').first().innerText({ timeout: 5000 }).catch(() => null);
    }
    await scrollThrough(page, 6, 1500);

    const cards = (await readCards(page)).map(parseCard).filter((c) => c.listingId);
    let onThisPage = 0;
    for (const card of cards) {
      if (seen.has(card.listingId)) continue;
      seen.add(card.listingId);
      onThisPage++;
      // Prefer Booking's own absolute position (hapos) when present.
      const position = card.hapos || results.length + 1;
      const { hapos, ...rest } = card;
      results.push({ ...rest, page: pageNum, position, isOurs: isOurs(card.listingId, ourId) });
    }
    if (pageNum === 1) pageSize = onThisPage;
    if (onThisPage === 0 || results.some((r) => r.isOurs)) break;
    await jitter(2000, 5000);
  }

  results.sort((a, b) => a.position - b.position);
  return { status: 'ok', results, pageSize, totalResults };
}
