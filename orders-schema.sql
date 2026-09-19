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

alter table public.orders enable row level security;

drop policy if exists "Public can create orders" on public.orders;
create policy "Public can create orders"
on public.orders for insert to anon, authenticated
with check (true);

drop policy if exists "Admins can read orders" on public.orders;
create policy "Admins can read orders"
on public.orders for select to authenticated
using (true);

drop policy if exists "Admins can update orders" on public.orders;
create policy "Admins can update orders"
on public.orders for update to authenticated
using (true) with check (true);
