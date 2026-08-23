import ical from 'node-ical';
import { createClient } from '@supabase/supabase-js';

const SOURCES = [
  { key: 'airbnb', url: process.env.ICAL_URL_AIRBNB },
  { key: 'vrbo', url: process.env.ICAL_URL_VRBO },
  { key: 'booking', url: process.env.ICAL_URL_BOOKING },
];

function toDateOnly(d) {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
    .toISOString()
    .slice(0, 10);
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Supabase server env vars are not configured' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const summary = { synced: 0, cancelled: 0, errors: [] };

  for (const source of SOURCES) {
    if (!source.url) {
      summary.errors.push(`No iCal URL configured for ${source.key} (set ICAL_URL_${source.key.toUpperCase()})`);
      continue;
    }

    try {
      const events = await ical.async.fromURL(source.url);
      const seenUids = [];
      const rows = [];
      const now = new Date().toISOString();

      for (const key of Object.keys(events)) {
        const ev = events[key];
        if (ev.type !== 'VEVENT' || !ev.start || !ev.end || !ev.uid) continue;

        const uid = `${source.key}:${ev.uid}`;
        seenUids.push(uid);
        rows.push({
          uid,
          source: source.key,
          summary: ev.summary || null,
          start_date: toDateOnly(ev.start),
          end_date: toDateOnly(ev.end),
          cancelled: false,
          last_synced_at: now,
        });
      }

      if (rows.length > 0) {
        const { error } = await supabase
          .from('bookings')
          .upsert(rows, { onConflict: 'uid' });
        if (error) throw error;
        summary.synced += rows.length;
      }

      // Anything previously synced for this source that no longer appears
      // in the feed has been cancelled or removed upstream.
      const { data: existing, error: existingErr } = await supabase
        .from('bookings')
        .select('uid')
        .eq('source', source.key)
        .eq('cancelled', false);
      if (existingErr) throw existingErr;

      const missingUids = (existing || [])
        .map((r) => r.uid)
        .filter((uid) => !seenUids.includes(uid));

      if (missingUids.length > 0) {
        const { error: cancelErr } = await supabase
          .from('bookings')
          .update({ cancelled: true })
          .in('uid', missingUids);
        if (cancelErr) throw cancelErr;
        summary.cancelled += missingUids.length;
      }
    } catch (err) {
      summary.errors.push(`${source.key}: ${err.message}`);
    }
  }

  return res.status(200).json(summary);
}
