-- Run this whole file once in the Supabase SQL Editor (Project -> SQL Editor -> New query).

-- ============================================================
-- bookings: one row per reservation, pulled in daily from iCal
-- ============================================================
create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  uid text unique not null,                    -- stable id: "<source>:<ical uid>"
  source text not null check (source in ('airbnb', 'vrbo', 'booking')),
  summary text,
  start_date date not null,
  end_date date not null,
  assigned_cleaner text check (assigned_cleaner in ('kyle_stephanie', 'baylie', 'em')),
  status text not null default 'pending' check (status in ('pending', 'complete')),
  notes text,
  next_guest_count integer check (next_guest_count is null or next_guest_count >= 0),
  checklist_state jsonb not null default '{}'::jsonb,
  cancelled boolean not null default false,
  last_synced_at timestamptz not null default now()
);

alter table public.bookings enable row level security;

drop policy if exists "public read bookings" on public.bookings;
create policy "public read bookings"
  on public.bookings for select
  to anon
  using (true);

-- No insert/update/delete policy for anon on this table on purpose.
-- Writes to bookings come from either:
--   1. the daily sync function (uses the service_role key, bypasses RLS), or
--   2. the update_booking() function below (runs as its creator, validates inputs).

-- ============================================================
-- booking_photos: cleaning proof photos (and photos attached to issues)
-- ============================================================
create table if not exists public.booking_photos (
  id uuid primary key default gen_random_uuid(),
  booking_uid text not null references public.bookings(uid) on delete cascade,
  kind text not null check (kind in ('proof', 'issue')),
  photo_url text not null,
  created_at timestamptz not null default now()
);

alter table public.booking_photos enable row level security;

drop policy if exists "public read photos" on public.booking_photos;
create policy "public read photos"
  on public.booking_photos for select
  to anon
  using (true);

drop policy if exists "public insert photos" on public.booking_photos;
create policy "public insert photos"
  on public.booking_photos for insert
  to anon
  with check (true);

-- ============================================================
-- issues: problems flagged by a cleaner during a turnover
-- ============================================================
create table if not exists public.issues (
  id uuid primary key default gen_random_uuid(),
  booking_uid text not null references public.bookings(uid) on delete cascade,
  description text not null,
  photo_url text,
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.issues enable row level security;

drop policy if exists "public read issues" on public.issues;
create policy "public read issues"
  on public.issues for select
  to anon
  using (true);

drop policy if exists "public insert issues" on public.issues;
create policy "public insert issues"
  on public.issues for insert
  to anon
  with check (true);

-- ============================================================
-- Storage bucket for photos (proof + issue photos)
-- ============================================================
insert into storage.buckets (id, name, public)
values ('cleaning-photos', 'cleaning-photos', true)
on conflict (id) do nothing;

drop policy if exists "public read cleaning photos" on storage.objects;
create policy "public read cleaning photos"
  on storage.objects for select
  to anon
  using (bucket_id = 'cleaning-photos');

drop policy if exists "public upload cleaning photos" on storage.objects;
create policy "public upload cleaning photos"
  on storage.objects for insert
  to anon
  with check (bucket_id = 'cleaning-photos');

-- ============================================================
-- update_booking: the only way the public (anon) key can modify a
-- booking. Validates the cleaner/status values so a stray write
-- can't corrupt data, and can never touch dates/source/uid.
-- ============================================================
create or replace function public.update_booking(
  p_uid text,
  p_assigned_cleaner text,
  p_status text,
  p_notes text,
  p_next_guest_count integer,
  p_checklist_state jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_assigned_cleaner is not null and p_assigned_cleaner not in ('kyle_stephanie', 'baylie', 'em') then
    raise exception 'invalid cleaner: %', p_assigned_cleaner;
  end if;

  if p_status not in ('pending', 'complete') then
    raise exception 'invalid status: %', p_status;
  end if;

  if p_next_guest_count is not null and p_next_guest_count < 0 then
    raise exception 'invalid guest count: %', p_next_guest_count;
  end if;

  update public.bookings
  set
    assigned_cleaner = p_assigned_cleaner,
    status = p_status,
    notes = p_notes,
    next_guest_count = p_next_guest_count,
    checklist_state = coalesce(p_checklist_state, '{}'::jsonb)
  where uid = p_uid;
end;
$$;

revoke all on function public.update_booking(text, text, text, text, integer, jsonb) from public;
grant execute on function public.update_booking(text, text, text, text, integer, jsonb) to anon;

-- ============================================================
-- set_issue_resolved: lets anyone mark a reported issue resolved
-- without granting general UPDATE on the issues table.
-- ============================================================
create or replace function public.set_issue_resolved(
  p_issue_id uuid,
  p_resolved boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.issues set resolved = p_resolved where id = p_issue_id;
end;
$$;

revoke all on function public.set_issue_resolved(uuid, boolean) from public;
grant execute on function public.set_issue_resolved(uuid, boolean) to anon;

-- ============================================================
-- cleaner_unavailability: date ranges a cleaner is blocked off
-- (vacation, sick, etc.), shown on the calendar as their own bar.
-- ============================================================
create table if not exists public.cleaner_unavailability (
  id uuid primary key default gen_random_uuid(),
  cleaner text not null check (cleaner in ('kyle_stephanie', 'baylie', 'em')),
  start_date date not null,
  end_date date not null check (end_date >= start_date),
  reason text,
  created_at timestamptz not null default now()
);

alter table public.cleaner_unavailability enable row level security;

drop policy if exists "public read unavailability" on public.cleaner_unavailability;
create policy "public read unavailability"
  on public.cleaner_unavailability for select
  to anon
  using (true);

drop policy if exists "public insert unavailability" on public.cleaner_unavailability;
create policy "public insert unavailability"
  on public.cleaner_unavailability for insert
  to anon
  with check (cleaner in ('kyle_stephanie', 'baylie', 'em'));

drop policy if exists "public delete unavailability" on public.cleaner_unavailability;
create policy "public delete unavailability"
  on public.cleaner_unavailability for delete
  to anon
  using (true);
