import { spawn } from 'node:child_process';
import { parseMoney, parseCount, scrollUntilStable, findBadges, jitter, sleep, pastedSearchUrl, CHILD_AGE, parseCapacity } from './common.js';

export const key = 'vrbo';
// VRBO blocks headless browsers outright, so it runs in a visible Chrome window.
export const needsRealBrowser = true;
// VRBO starts asking "Bot or Not?" after a few searches close together, so it
// is searched lightly: "every open night" searches check one stay per open
// week, and consecutive VRBO searches are spread out (run.js reads these).
export const oneStayPerWeek = true;
export const minGapMs = Number(process.env.VRBO_MIN_GAP_MINUTES ?? 3) * 60000;

export function buildUrl(search, checkin, checkout) {
  // A pasted VRBO search URL carries the resolved regionId, which a plain
  // place name sometimes doesn't.
  const children = search.children || 0;
  const pasted = pastedSearchUrl(search.location, /(^|.)vrbo.com$/i);
  const url = pasted || new URL('https://www.vrbo.com/search');
  if (!pasted) url.searchParams.set('destination', search.location);
  url.searchParams.set('startDate', checkin);
  url.searchParams.set('endDate', checkout);
  url.searchParams.set('d1', checkin);
  url.searchParams.set('d2', checkout);
  url.searchParams.set('adults', String(search.adults));
  // VRBO encodes each child as "<room>_<age>", comma-separated.
  if (children) url.searchParams.set('children', Array.from({ length: children }, () => `1_${CHILD_AGE}`).join(','));
  else url.searchParams.delete('children');
  return url.toString();
}

// Our VRBO id is the number in https://www.vrbo.com/<id> (sometimes shown as <id>ha).
export function idFromUrl(href) {
  try {
    const first = new URL(href).pathname.split('/').filter(Boolean)[0] || '';
    const m = first.match(/^(\d+)(?:ha)?$/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function isOurs(listingId, ourId) {
  return !!ourId && String(listingId) === String(ourId).trim().replace(/ha$/i, '');
}

const BADGES = ['Premier Host', 'VIP Access', 'Member Price', 'Guest favorite', 'Great for families', 'Free cancellation'];

// A Windows toast via PowerShell (no extra dependencies), shown under
// PowerShell's own app id. Built from XML because indexing the template's
// text nodes is unreliable in Windows PowerShell 5.1. Fire-and-forget: a
// failed notification must never stop the run.
export function notifyHumanCheck(minutes) {
  if (process.platform !== 'win32') return;
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, "''");
  const title = 'VRBO needs a human check';
  const body = `Clear the "Bot or Not?" check in the Chrome window within ${minutes} min so the rank tracker can continue.`;
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(body)}</text></binding></visual></toast>`;
  const ps = [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
    "$d = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$d.LoadXml('${xml}')`,
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($d))",
  ].join('; ');
  try {
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  } catch {}
}

async function isBlocked(page) {
  const title = await page.title().catch(() => '');
  return /bot or not/i.test(title);
}

// If VRBO shows its "Bot or Not?" check, leave the window open and wait
// for a person to clear it by hand. We never try to solve it automatically.
async function waitForHuman(page, waitMs) {
  if (!(await isBlocked(page))) return true;
  if (!waitMs) return false;
  // Bring the window forward and pop a Windows notification so the check can
  // be cleared by hand. The tracker never tries to solve it itself.
  await page.bringToFront().catch(() => {});
  notifyHumanCheck(Math.round(waitMs / 60000));
  console.log(`  VRBO is asking for a human check - clear it in the Chrome window (waiting up to ${Math.round(waitMs / 60000)} min)...`);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (!(await isBlocked(page))) return true;
  }
  return false;
}

async function readCards(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-stid="lodging-card-responsive"]')].map((card) => {
      const link = card.querySelector('a[data-stid="open-product-information"], a[data-stid="open-hotel-information"]')
        || [...card.querySelectorAll('a[href]')].find((a) => /vrbo\.com\/\d+/.test(a.href));
      return {
        href: link?.href || '',
        title: card.querySelector('h3')?.innerText || null,
        priceText: card.querySelector('[data-stid="product-price-summary"], [data-test-id="price-summary"]')?.innerText || '',
        sponsored: !!card.querySelector('[data-stid="sponsored-ad-badge"]'),
        text: card.innerText,
      };
    })
  );
}

function parseCard(c) {
  const id = idFromUrl(c.href);
  const total = c.priceText.match(/\$([\d,]+)\s*(?:total|for \d+ nights?)/i)
    || c.text.match(/\$([\d,]+)\s*(?:total|for \d+ nights?)/i);
  const rating = c.text.match(/([\d.]+)\s*out of\s*(5|10)/i);
  const reviews = c.text.match(/\(?([\d,]+)\s+reviews?\)?/i);
  return {
    listingId: id,
    title: (c.title || '').replace(/^Photo gallery for\s+/i, '') || null,
    url: id ? `https://www.vrbo.com/${id}` : null,
    price: total ? Number(total[1].replace(/,/g, '')) : parseMoney(c.priceText) ?? parseMoney(c.text),
    rating: rating ? Number(rating[1]) : null,
    ratingScale: rating ? Number(rating[2]) : null,
    reviewCount: reviews ? parseCount(reviews[1]) : null,
    badges: findBadges(c.text, BADGES),
    sponsored: c.sponsored,
    ...parseCapacity(c.text),
  };
}

export async function scrape(page, { url, ourId, maxPages, humanWaitMs }) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);
  if (!(await waitForHuman(page, humanWaitMs))) {
    return { status: 'blocked', results: [], pageSize: null, totalResults: null };
  }
  await page.waitForSelector('[data-stid="lodging-card-responsive"]', { timeout: 30000 });

  const totalResults = await page
    .locator('[data-stid="results-header-message"]')
    .first()
    .innerText({ timeout: 5000 })
    .catch(() => null);

  const results = [];
  const seen = new Set();
  let pageSize = null;

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    // VRBO sometimes renders only a few cards at first and loads the rest
    // after a pause, so give a short page one more pass before trusting it.
    let loaded = await scrollUntilStable(page, '[data-stid="lodging-card-responsive"]');
    if (loaded < 10) {
      await sleep(4000);
      await scrollUntilStable(page, '[data-stid="lodging-card-responsive"]');
    }
    const cards = (await readCards(page)).map(parseCard).filter((c) => c.listingId);
    let onThisPage = 0;
    for (const card of cards) {
      if (seen.has(card.listingId)) continue;
      seen.add(card.listingId);
      onThisPage++;
      results.push({ ...card, page: pageNum, position: results.length + 1, isOurs: isOurs(card.listingId, ourId) });
    }
    if (pageNum === 1) pageSize = onThisPage;
    if (results.some((r) => r.isOurs)) break;

    const next = page.locator('[data-stid="next-button"]').first();
    const canGoNext = await next.isEnabled({ timeout: 3000 }).catch(() => false);
    if (!canGoNext) break;
    await jitter(2000, 5000);
    await next.click();
    await sleep(4000);
    if (!(await waitForHuman(page, humanWaitMs))) break;
    await page.waitForSelector('[data-stid="lodging-card-responsive"]', { timeout: 30000 }).catch(() => {});
  }

  return { status: 'ok', results, pageSize, totalResults };
}
