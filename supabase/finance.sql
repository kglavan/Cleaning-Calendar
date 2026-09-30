-- Finance tab tables. Run this whole file once in the Supabase SQL Editor.
-- Safe to re-run.
--
-- ACCESS: for now these tables are readable and writable with the public
-- (anon) key, like the cleaning calendar - the owner chose no sign-in yet.
-- Deletes are not allowed from the page: a wrong row is marked excluded.
-- To lock this down later, replace the "to anon" policies below with
-- policies for signed-in (authenticated) users; the page won't need to change.

-- ============================================================
-- fin_transactions: every bank / card / Venmo transaction, imported from
-- Stessa's "Export CSV". Descriptions are stored with bank reference
-- numbers (PPD/CCD/WEB IDs, long digit runs) stripped out.
-- ============================================================
create table if not exists public.fin_transactions (
  id text primary key,                 -- stable hash of the original row, so re-imports don't duplicate
  date date not null,
  description text not null,
  amount numeric not null,             -- income positive, expense negative (as Stessa shows it)
  category text,                       -- Stessa category, e.g. "Utilities"
  sub_category text,                   -- Stessa sub-category, e.g. "Electric"
  property text,
  account text,                        -- e.g. "Chase CPC Checking", "American Express ..."
  platform text,                       -- airbnb / vrbo / booking / direct, derived for income
  notes text,
  excluded boolean not null default false,
  imported_at timestamptz not null default now()
);

create index if not exists fin_transactions_date_idx on public.fin_transactions (date);

alter table public.fin_transactions enable row level security;

drop policy if exists "public read fin transactions" on public.fin_transactions;
create policy "public read fin transactions" on public.fin_transactions for select to anon using (true);
drop policy if exists "public insert fin transactions" on public.fin_transactions;
create policy "public insert fin transactions" on public.fin_transactions for insert to anon with check (true);
drop policy if exists "public update fin transactions" on public.fin_transactions;
create policy "public update fin transactions" on public.fin_transactions for update to anon using (true) with check (true);

-- ============================================================
-- fin_activity: the trip / work log that replaces the expenses workbook -
-- mileage, material participation hours, attendees and business purpose.
-- Amounts here are for reference only (the purchase itself is already a
-- bank/card transaction), so reports never add them to expenses.
-- ============================================================
create table if not exists public.fin_activity (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  description text not null,
  attendees text,
  purpose text,
  vendor text,
  miles numeric not null default 0 check (miles >= 0),
  amount numeric,
  hours numeric not null default 0 check (hours >= 0),
  notes text,
  source text not null default 'manual' check (source in ('manual', 'workbook', 'calendar')),
  booking_uid text,                    -- set when created from a cleaning-calendar suggestion
  excluded boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists fin_activity_date_idx on public.fin_activity (date);
create unique index if not exists fin_activity_booking_uid_idx on public.fin_activity (booking_uid) where booking_uid is not null;

alter table public.fin_activity enable row level security;

drop policy if exists "public read fin activity" on public.fin_activity;
create policy "public read fin activity" on public.fin_activity for select to anon using (true);
drop policy if exists "public insert fin activity" on public.fin_activity;
create policy "public insert fin activity" on public.fin_activity for insert to anon with check (true);
drop policy if exists "public update fin activity" on public.fin_activity;
create policy "public update fin activity" on public.fin_activity for update to anon using (true) with check (true);

-- ============================================================
-- fin_settings: small key/value settings edited on the page
-- (mileage rate per year, occupancy tax rates, default trip miles/hours).
-- ============================================================
create table if not exists public.fin_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.fin_settings enable row level security;

drop policy if exists "public read fin settings" on public.fin_settings;
create policy "public read fin settings" on public.fin_settings for select to anon using (true);
drop policy if exists "public upsert fin settings" on public.fin_settings;
create policy "public upsert fin settings" on public.fin_settings for insert to anon with check (true);
drop policy if exists "public update fin settings" on public.fin_settings;
create policy "public update fin settings" on public.fin_settings for update to anon using (true) with check (true);

insert into public.fin_settings (key, value) values
  ('occupancy_tax', '[
     {"name": "Colorado Sales & Use Tax", "rate": 0.029},
     {"name": "El Paso Local Sales & Use Tax", "rate": 0.0123},
     {"name": "Pikes Peak Rural Transportation Authority", "rate": 0.01}
   ]'::jsonb),
  ('mileage_rate', '{"2025": 0.70}'::jsonb),
  ('cleaning_trip', '{"miles": 55, "hours": 3}'::jsonb)
on conflict (key) do nothing;
