export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Random pause so runs don't hammer a site on a fixed rhythm.
export const jitter = (minMs, maxMs) => sleep(minMs + Math.random() * (maxMs - minMs));

export function parseMoney(text) {
  if (!text) return null;
  const m = String(text).match(/\$\s?([\d,]+(?:\.\d+)?)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

export function parseCount(text) {
  if (!text) return null;
  const n = Number(String(text).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Scroll down in steps so lazy-loaded result cards render.
export async function scrollThrough(page, steps = 10, stepPx = 1500) {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, stepPx);
    await sleep(350 + Math.random() * 300);
  }
}

// Case-insensitive phrases worth surfacing as badges in the competitor table.
export function findBadges(text, phrases) {
  const lower = (text || '').toLowerCase();
  return phrases.filter((p) => lower.includes(p.toLowerCase()));
}

// A saved search's location can be a city ("Gatlinburg, TN") or a full
// search URL copied from the site (to keep its map area and filters).
// Returns a URL object for a pasted URL on this site, else null.
export function pastedSearchUrl(location, hostPattern) {
  if (!/^https?:\/\//i.test(location || '')) return null;
  const url = new URL(location.trim());
  if (!hostPattern.test(url.hostname)) {
    throw new Error(`Search URL is for ${url.hostname}, not this platform`);
  }
  return url;
}

// Sites need an age for each child. None of the three rank differently by
// age within 2-12, so every child is searched as this age.
export const CHILD_AGE = 8;

// Keep scrolling until the number of result cards stops growing, for sites
// that load results in batches as you scroll.
export async function scrollUntilStable(page, cardSelector, { maxRounds = 30, stepPx = 1500 } = {}) {
  let last = -1;
  let stableRounds = 0;
  for (let i = 0; i < maxRounds && stableRounds < 3; i++) {
    await page.mouse.wheel(0, stepPx);
    await sleep(600 + Math.random() * 400);
    const count = await page.locator(cardSelector).count();
    stableRounds = count === last ? stableRounds + 1 : 0;
    last = count;
  }
  return last;
}

// Bedrooms/guest capacity from a result card ("3 bedrooms", "Studio",
// "Sleeps 8"), used to compare prices against similar-size listings.
export function parseCapacity(text) {
  const t = text || '';
  const beds = t.match(/(\d+)\s+bedrooms?\b/i);
  const sleeps = t.match(/sleeps\s+(\d+)/i);
  return {
    bedrooms: beds ? Number(beds[1]) : /\bstudio\b/i.test(t) ? 0 : null,
    sleeps: sleeps ? Number(sleeps[1]) : null,
  };
}
