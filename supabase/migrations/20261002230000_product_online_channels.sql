alter table public.products
  add column if not exists visible_in_menu boolean;

update public.products
set visible_in_menu = true
where visible_in_menu is null;

alter table public.products
  alter column visible_in_menu set default true,
  alter column visible_in_menu set not null;

comment on column public.products.visible_in_menu is
  'Whether the product is shown on the read-only online menu; online ordering remains controlled by available_online.';

create index if not exists products_visible_online_menu_idx
  on public.products (category_id, sort_order, name)
  where is_active = true and visible_in_menu = true;
