-- Run this whole file in the Supabase SQL Editor.

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_name text not null,
  customer_phone text not null,
  address text not null,
  map_url text,
  notes text,
  items jsonb not null default '[]'::jsonb,
  total integer not null default 0,
  status text not null default 'new' check (status in ('new','confirmed','preparing','ready','delivered','cancelled')),
  created_at timestamptz not null default now()
);

-- Only accounts listed here can open the admin dashboard data.
create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;

drop policy if exists "Admins can see own row" on public.admin_users;
create policy "Admins can see own row"
on public.admin_users for select to authenticated
using (user_id = auth.uid());

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admin_users where user_id = auth.uid());
$$;

alter table public.orders enable row level security;

-- Customers can only create new orders; they cannot pick another status.
drop policy if exists "Public can create orders" on public.orders;
create policy "Public can create orders"
on public.orders for insert to anon, authenticated
with check (status = 'new');

drop policy if exists "Admins can read orders" on public.orders;
create policy "Admins can read orders"
on public.orders for select to authenticated
using (public.is_admin());

drop policy if exists "Admins can update orders" on public.orders;
create policy "Admins can update orders"
on public.orders for update to authenticated
using (public.is_admin()) with check (public.is_admin());

-- Menu: everyone can read it, only admins can change it.
do $$
begin
  if to_regclass('public.menu_items') is not null then
    alter table public.menu_items enable row level security;

    drop policy if exists "Public can read menu" on public.menu_items;
    create policy "Public can read menu"
    on public.menu_items for select to anon, authenticated
    using (true);

    drop policy if exists "Admins can manage menu" on public.menu_items;
    create policy "Admins can manage menu"
    on public.menu_items for all to authenticated
    using (public.is_admin()) with check (public.is_admin());
  end if;
end $$;

-- Add your admin account (create it first under Authentication > Users),
-- replacing the email below with the real one:
-- insert into public.admin_users (user_id)
-- select id from auth.users where email = 'admin@cafenine.com'
-- on conflict do nothing;
