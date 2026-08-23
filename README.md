# Turnover Cleaning Calendar

A no-login, hosted calendar for one Airbnb/VRBO/Booking.com listing. It pulls all
three booking calendars in daily via iCal, shows them color-coded on one
calendar, and lets Kyle & Stephanie, Baylie, or Em pick up a cleaning, run a
checklist, note the next guest count (for linens), upload proof photos, and
flag issues - all from a link, no account needed.

## How it's built

- **Frontend**: a single static page (`public/`) - FullCalendar for the
  calendar view, plain JS, no build step.
- **Database**: [Supabase](https://supabase.com) (free tier) - Postgres +
  file storage for photos.
- **Sync**: a Vercel serverless function (`api/sync.js`) fetches the three
  iCal feeds once a day (via Vercel Cron) and upserts bookings without
  touching any manual assignment/status/notes/checklist data already saved.
- **No login, but writes are locked down**: the public key can only read
  bookings and call two whitelisted functions (`update_booking`,
  `set_issue_resolved`). It can never change dates, delete bookings, or wipe
  the calendar. Since there's no auth, treat the live URL as unlisted -
  don't publish it publicly, just share it with your cleaners.

## One-time setup

### 1. Create the Supabase project

1. Go to [supabase.com](https://supabase.com) and create a free project.
2. Open **SQL Editor** -> **New query**, paste in the contents of
   [`supabase/schema.sql`](supabase/schema.sql), and run it. This creates all
   tables, the photo storage bucket, and the two RPC functions.
3. Go to **Project Settings -> API** and copy:
   - **Project URL**
   - **anon public** key
   - **service_role** key (keep this one secret - server-side only)

### 2. Get your iCal export URLs

- **Airbnb**: Listing -> Calendar -> Availability -> Export Calendar
- **VRBO**: Listing -> Calendar -> Import/Export -> Export Calendar
- **Booking.com**: Extranet -> Calendar -> Sync calendars -> Export calendar

### 3. Fill in the frontend config

Edit [`public/config.js`](public/config.js) and set:

```js
SUPABASE_URL: "https://YOUR-PROJECT.supabase.co",
SUPABASE_ANON_KEY: "YOUR-ANON-KEY",
```

(These two values are meant to be public - safe to commit.)

### 4. Deploy to Vercel

1. Push this project to a GitHub repo, then import it at
   [vercel.com/new](https://vercel.com/new) - or run `npx vercel` from this
   folder and follow the prompts.
2. In the Vercel project's **Settings -> Environment Variables**, add:

   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | same project URL as above |
   | `SUPABASE_SERVICE_ROLE_KEY` | the service_role key (never put this in `public/`) |
   | `ICAL_URL_AIRBNB` | your Airbnb export URL |
   | `ICAL_URL_VRBO` | your VRBO export URL |
   | `ICAL_URL_BOOKING` | your Booking.com export URL |

3. Redeploy so the env vars take effect.
4. Visit the deployed URL, click **Sync Now** once to pull in the first
   batch of bookings, and confirm they show up on the calendar.

Vercel's free (Hobby) plan supports daily cron triggers, which is what
`vercel.json` is set up for (`0 8 * * *` = 8:00 UTC daily - edit the schedule
if you want a different time). If cron ever isn't available on your plan,
you can point a free external scheduler (e.g. cron-job.org) at
`https://your-deployed-url/api/sync` once a day as a fallback.

## Editing the checklist or cleaners later

Everything editable without touching app logic lives in
[`public/config.js`](public/config.js): the cleaner list, the checklist
items, and the source colors/labels.

## Local development

```bash
npm install
npx vercel dev
```

This runs both the static frontend and the `/api/sync` function locally
(requires a `.env` file - copy `.env.example` and fill in the server-side
values; Vercel CLI loads it automatically).
