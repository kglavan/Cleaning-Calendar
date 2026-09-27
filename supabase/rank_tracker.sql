-- Search rank tracker tables. Run this whole file once in the Supabase SQL
-- Editor (after schema.sql). Safe to re-run.

-- ============================================================
-- rank_searches: the guest-style searches we check every day.
-- One row per platform + guest mix. Dates come from date_mode:
--   calendar   - every open night in the next `horizon_days`, split into
--                stays of about `nights` nights (feeds the calendar view)
--   open_dates - the next `open_windows` stays of `nights` nights that
--                are open on our booking calendar (bookings table)
--   fixed      - exactly fixed_checkin -> fixed_checkout
--   offset     - check-in `checkin_offset_days` from the run date
-- ============================================================
create table if not exists public.rank_searches (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('airbnb', 'vrbo', 'booking')),
  label text not null,
  location text not null,           -- place name as typed on that site, or a pasted search URL
  adults integer not null default 2 check (adults between 1 and 16),
  children integer not null default 0 check (children between 0 and 10),
  date_mode text not null default 'open_dates' check (date_mode in ('calendar', 'open_dates', 'fixed', 'offset')),
  nights integer not null default 2 check (nights between 1 and 30),
  open_windows integer not null default 2 check (open_windows between 1 and 6),
  horizon_days integer not null default 45 check (horizon_days between 7 and 120),
  fixed_checkin date,
  fixed_checkout date,
  checkin_offset_days integer not null default 14 check (checkin_offset_days between 0 and 365),
  max_pages integer not null default 5 check (max_pages between 1 and 15),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (date_mode <> 'fixed' or (fixed_checkin is not null and fixed_checkout > fixed_checkin))
);

alter table public.rank_searches enable row level security;

drop policy if exists "public read rank searches" on public.rank_searches;
create policy "public read rank searches"
  on public.rank_searches for select to anon using (true);

drop policy if exists "public insert rank searches" on public.rank_searches;
create policy "public insert rank searches"
  on public.rank_searches for insert to anon with check (true);

drop policy if exists "public update rank searches" on public.rank_searches;
create policy "public update rank searches"
  on public.rank_searches for update to anon using (true) with check (true);

drop policy if exists "public delete rank searches" on public.rank_searches;
create policy "public delete rank searches"
  on public.rank_searches for delete to anon using (true);

-- ============================================================
-- rank_snapshots: one row per search per tracker run.
-- Written only by the tracker (service_role key).
-- ============================================================
create table if not exists public.rank_snapshots (
  id uuid primary key default gen_random_uuid(),
  search_id uuid not null references public.rank_searches(id) on delete cascade,
  run_at timestamptz not null default now(),
  checkin date not null,
  checkout date not null,
  status text not null check (status in ('found', 'not_found', 'blocked', 'error')),
  rank integer,                 -- absolute position across all pages scanned
  page integer,                 -- results page our listing appeared on
  page_size integer,            -- listings on page 1 (varies by platform)
  results_scanned integer not null default 0,
  total_results text,           -- the site's own "852 properties" header, as shown
  our_price numeric,            -- total for the stay, as displayed in search
  error text
);

create index if not exists rank_snapshots_search_run_idx
  on public.rank_snapshots (search_id, run_at desc);

alter table public.rank_snapshots enable row level security;

drop policy if exists "public read rank snapshots" on public.rank_snapshots;
create policy "public read rank snapshots"
  on public.rank_snapshots for select to anon using (true);

-- ============================================================
-- rank_competitors: page-1 listings (plus our own row wherever it
-- landed) for each snapshot. Written only by the tracker.
-- ============================================================
create table if not exists public.rank_competitors (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.rank_snapshots(id) on delete cascade,
  position integer not null,
  page integer not null,
  listing_id text,
  title text,
  url text,
  price numeric,                -- total for the stay
  rating numeric,               -- Airbnb/VRBO: out of 5 (or 10 on VRBO), Booking: out of 10
  rating_scale integer,
  review_count integer,
  badges text[] not null default '{}',
  bedrooms integer,             -- from the card, for like-for-like price comparisons
  sleeps integer,
  sponsored boolean not null default false,
  is_ours boolean not null default false
);

create index if not exists rank_competitors_snapshot_idx
  on public.rank_competitors (snapshot_id, position);

alter table public.rank_competitors enable row level security;

drop policy if exists "public read rank competitors" on public.rank_competitors;
create policy "public read rank competitors"
  on public.rank_competitors for select to anon using (true);
