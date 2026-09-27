import { parseMoney, parseCount, scrollThrough, findBadges, jitter, pastedSearchUrl, CHILD_AGE, parseCapacity } from './common.js';

export const key = 'airbnb';
export const needsRealBrowser = false;

export function buildUrl(search, checkin, checkout) {
  const children = search.children || 0;
  const pasted = pastedSearchUrl(search.location, /(^|.)airbnb./i);
  const url = pasted || new URL(`https://www.airbnb.com/s/${encodeURIComponent(search.location)}/homes`);
  for (const p of ['cursor', 'pagination_search', 'date_picker_type', 'flexible_trip_lengths[]', 'monthly_start_date', 'children', 'infants']) {
    url.searchParams.delete(p);
  }
  url.searchParams.set('checkin', checkin);
  url.searchParams.set('checkout', checkout);
  url.searchParams.set('adults', String(search.adults));
  if (children) url.searchParams.set('children', String(children));
  return url.toString();
}

// Our Airbnb listing id is the number in https://www.airbnb.com/rooms/<id>
export function isOurs(listingId, ourId) {
  return !!ourId && String(listingId) === String(ourId).trim();
}

const BADGES = ['Top guest favorite', 'Guest favorite', 'Superhost', 'Rare find', 'New'];

async function readCards(page) {
  return page.evaluate(() => {
    const out = [];
    for (const card of document.querySelectorAll('[itemprop="itemListElement"]')) {
      const url = card.querySelector('meta[itemprop="url"]')?.content || '';
      const idMatch = url.match(/\/rooms\/(?:plus\/)?(\d+)/);
      if (!idMatch) continue;
      out.push({
        listingId: idMatch[1],
        title: card.querySelector('meta[itemprop="name"]')?.content
          || card.querySelector('[data-testid="listing-card-name"]')?.innerText
          || null,
        url: 'https://www.airbnb.com/rooms/' + idMatch[1],
        text: card.innerText,
      });
    }
    return out;
  });
}

function parseCard(c) {
  const lines = c.text.split('\n').map((l) => l.trim()).filter(Boolean);
  // The accessible price line reads like "$574 for 2 nights"; with a
  // discount it may include the original price first, so take the last $.
  // Discounted cards instead show the original and sale price on their own
  // lines ("$705", "$555") just above "Show price breakdown".
  const priceLine = lines.find((l) => /\$[\d,]+.*for \d+ nights?/i.test(l)) || '';
  let prices = priceLine.match(/\$[\d,]+/g) || [];
  let discounted = false;
  if (!prices.length) {
    const end = lines.findIndex((l) => /show price breakdown|^for \d+ nights?$/i.test(l));
    const before = [];
    for (let i = end - 1; i >= 0 && /^\$[\d,]+$/.test(lines[i]); i--) before.unshift(lines[i]);
    prices = before;
    discounted = before.length > 1;
  }
  if (!prices.length && process.env.DEBUG) console.log('  [airbnb] no price parsed:', lines.join(' | ').slice(0, 400));
  const ratingMatch = c.text.match(/([\d.]+) out of 5 average rating,\s*([\d,]+) review/i);
  return {
    listingId: c.listingId,
    title: c.title,
    url: c.url,
    price: prices.length ? parseMoney(prices[prices.length - 1]) : null,
    rating: ratingMatch ? Number(ratingMatch[1]) : null,
    ratingScale: 5,
    reviewCount: ratingMatch ? parseCount(ratingMatch[2]) : null,
    badges: findBadges(lines.slice(0, 4).join(' | '), BADGES)
      // "Top guest favorite" already implies "Guest favorite"
      .filter((b, _, all) => !(b === 'Guest favorite' && all.includes('Top guest favorite')))
      .concat(discounted ? ['Discounted'] : [])
      .concat(/new place to stay/i.test(c.text) && !lines.slice(0, 4).includes('New') ? ['New'] : []),
    sponsored: false,
    ...parseCapacity(c.text),
  };
}

export async function scrape(page, { url, ourId, maxPages }) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('[itemprop="itemListElement"]', { timeout: 30000 });

  const totalResults = await page
    .evaluate(() => {
      const m = document.body.innerText.match(/(Over [\d,]+|[\d,]+\+?) (homes|places|stays)[^\n]*/i);
      return m ? m[0].slice(0, 80) : null;
    })
    .catch(() => null);

  const results = [];
  const seen = new Set();
  let pageSize = null;

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    await scrollThrough(page, 8, 2500);
    const cards = (await readCards(page)).map(parseCard);
    let onThisPage = 0;
    for (const card of cards) {
      if (seen.has(card.listingId)) continue;
      seen.add(card.listingId);
      onThisPage++;
      results.push({ ...card, page: pageNum, position: results.length + 1, isOurs: isOurs(card.listingId, ourId) });
    }
    if (pageNum === 1) pageSize = onThisPage;
    if (results.some((r) => r.isOurs)) break;

    const nextHref = await page
      .locator('a[aria-label="Next"]')
      .first()
      .getAttribute('href', { timeout: 5000 })
      .catch(() => null);
    if (!nextHref) break;
    await jitter(2000, 5000);
    await page.goto(new URL(nextHref, 'https://www.airbnb.com').toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('[itemprop="itemListElement"]', { timeout: 30000 });
  }

  return { status: 'ok', results, pageSize, totalResults };
}
