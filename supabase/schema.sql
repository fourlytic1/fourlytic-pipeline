-- =====================================================================
-- Fourlytic Pipeline — Supabase schema
-- Run this once in: Supabase Dashboard -> SQL Editor -> New query -> Run
-- =====================================================================

-- ---------------------------------------------------------------
-- PROFILES — one row per team member, linked to Supabase Auth.
-- This table is the real access gate: having an auth.users row
-- (even a self-registered one) grants nothing without a matching,
-- active profiles row.
-- ---------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  email text not null,
  display_name text not null,
  role text not null check (role in ('admin','sales')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- ---------------------------------------------------------------
-- Helper: is the current caller an active admin?
-- SECURITY DEFINER so it can be used inside other tables' policies
-- without those policies needing to read profiles directly.
-- ---------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and active
  );
$$;

create or replace function public.is_active_member()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and active
  );
$$;

-- ---------------------------------------------------------------
-- Helper: look up an email by username, for the login screen.
-- Callable by anonymous visitors (needed before they're signed in),
-- but it leaks nothing except "this username exists with this email"
-- — no passwords, no other profile fields.
-- ---------------------------------------------------------------
create or replace function public.email_for_username(p_username text)
returns text
language sql
security definer
set search_path = public
as $$
  select email from public.profiles
  where lower(username) = lower(p_username) and active
  limit 1;
$$;

grant execute on function public.email_for_username(text) to anon, authenticated;

-- ---------------------------------------------------------------
-- PROFILES policies
-- ---------------------------------------------------------------
drop policy if exists "profiles_select_self_or_admin" on public.profiles;
create policy "profiles_select_self_or_admin"
  on public.profiles for select
  using (id = auth.uid() or public.is_admin());

drop policy if exists "profiles_insert_admin_only" on public.profiles;
create policy "profiles_insert_admin_only"
  on public.profiles for insert
  with check (public.is_admin());

drop policy if exists "profiles_update_admin_only" on public.profiles;
create policy "profiles_update_admin_only"
  on public.profiles for update
  using (public.is_admin());

-- ---------------------------------------------------------------
-- COMPANIES
-- ---------------------------------------------------------------
create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  location text,
  website text,
  linkedin text,
  notes text,
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz
);
alter table public.companies enable row level security;

drop policy if exists "companies_rw_active_members" on public.companies;
drop policy if exists "companies_select_active_members" on public.companies;
drop policy if exists "companies_insert_active_members" on public.companies;
drop policy if exists "companies_update_active_members" on public.companies;
drop policy if exists "companies_delete_admin_only" on public.companies;
create policy "companies_select_active_members" on public.companies for select using (public.is_active_member());
create policy "companies_insert_active_members" on public.companies for insert with check (public.is_active_member());
create policy "companies_update_active_members" on public.companies for update using (public.is_active_member()) with check (public.is_active_member());
create policy "companies_delete_admin_only" on public.companies for delete using (public.is_admin());

-- ---------------------------------------------------------------
-- CONTACTS
-- ---------------------------------------------------------------
create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text,
  email text,
  phone text,
  company_id uuid references public.companies(id) on delete set null,
  lead_owner text,
  pseudo_profile_name text,
  location text,
  connected_info text,
  recruiter_linkedin text,
  company_linkedin text,
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz
);
alter table public.contacts enable row level security;

drop policy if exists "contacts_rw_active_members" on public.contacts;
drop policy if exists "contacts_select_active_members" on public.contacts;
drop policy if exists "contacts_insert_active_members" on public.contacts;
drop policy if exists "contacts_update_active_members" on public.contacts;
drop policy if exists "contacts_delete_admin_only" on public.contacts;
create policy "contacts_select_active_members" on public.contacts for select using (public.is_active_member());
create policy "contacts_insert_active_members" on public.contacts for insert with check (public.is_active_member());
create policy "contacts_update_active_members" on public.contacts for update using (public.is_active_member()) with check (public.is_active_member());
create policy "contacts_delete_admin_only" on public.contacts for delete using (public.is_admin());

-- ---------------------------------------------------------------
-- DEALS
-- ---------------------------------------------------------------
create table if not exists public.deals (
  id uuid primary key default gen_random_uuid(),
  deal_name text not null,
  date date,
  company_id uuid references public.companies(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  rate numeric,
  rate_type text,
  source text,
  stage text not null default 'contacted',
  job_type text,
  hr_call_by text,
  interview_by text,
  notes text,
  position_drop_reason text,
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz
);
alter table public.deals enable row level security;

drop policy if exists "deals_rw_active_members" on public.deals;
drop policy if exists "deals_select_active_members" on public.deals;
drop policy if exists "deals_insert_active_members" on public.deals;
drop policy if exists "deals_update_active_members" on public.deals;
drop policy if exists "deals_delete_admin_only" on public.deals;
create policy "deals_select_active_members" on public.deals for select using (public.is_active_member());
create policy "deals_insert_active_members" on public.deals for insert with check (public.is_active_member());
create policy "deals_update_active_members" on public.deals for update using (public.is_active_member()) with check (public.is_active_member());
create policy "deals_delete_admin_only" on public.deals for delete using (public.is_admin());

-- ---------------------------------------------------------------
-- ACTIVITIES (notes / calls / emails / conversations / stage changes)
-- ---------------------------------------------------------------
create table if not exists public.activities (
  id uuid primary key default gen_random_uuid(),
  parent_type text not null check (parent_type in ('contact','company','deal')),
  parent_id uuid not null,
  kind text not null default 'general',
  text text not null,
  by text,
  at timestamptz not null default now()
);
alter table public.activities enable row level security;

drop policy if exists "activities_rw_active_members" on public.activities;
drop policy if exists "activities_select_active_members" on public.activities;
drop policy if exists "activities_insert_active_members" on public.activities;
drop policy if exists "activities_update_active_members" on public.activities;
drop policy if exists "activities_delete_admin_only" on public.activities;
create policy "activities_select_active_members" on public.activities for select using (public.is_active_member());
create policy "activities_insert_active_members" on public.activities for insert with check (public.is_active_member());
create policy "activities_update_active_members" on public.activities for update using (public.is_active_member()) with check (public.is_active_member());
create policy "activities_delete_admin_only" on public.activities for delete using (public.is_admin());

create index if not exists activities_parent_idx on public.activities(parent_type, parent_id);

-- ---------------------------------------------------------------
-- TASKS
-- ---------------------------------------------------------------
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  parent_type text not null check (parent_type in ('contact','company','deal')),
  parent_id uuid not null,
  title text not null,
  due_date date,
  done boolean not null default false,
  assigned_to text,
  created_at timestamptz not null default now(),
  created_by text
);
alter table public.tasks enable row level security;

drop policy if exists "tasks_rw_active_members" on public.tasks;
drop policy if exists "tasks_select_active_members" on public.tasks;
drop policy if exists "tasks_insert_active_members" on public.tasks;
drop policy if exists "tasks_update_active_members" on public.tasks;
drop policy if exists "tasks_delete_admin_only" on public.tasks;
create policy "tasks_select_active_members" on public.tasks for select using (public.is_active_member());
create policy "tasks_insert_active_members" on public.tasks for insert with check (public.is_active_member());
create policy "tasks_update_active_members" on public.tasks for update using (public.is_active_member()) with check (public.is_active_member());
create policy "tasks_delete_admin_only" on public.tasks for delete using (public.is_admin());

create index if not exists tasks_parent_idx on public.tasks(parent_type, parent_id);

-- ---------------------------------------------------------------
-- REALTIME — so the app gets live updates across viewers
-- ---------------------------------------------------------------
alter publication supabase_realtime add table public.profiles, public.companies, public.contacts, public.deals, public.activities, public.tasks;
