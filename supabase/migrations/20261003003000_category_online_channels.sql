alter table public.categories
  add column if not exists available_online boolean,
  add column if not exists visible_in_menu boolean;

update public.categories
set available_online = is_active
where available_online is null;

update public.categories
set visible_in_menu = is_active
where visible_in_menu is null;

alter table public.categories
  alter column available_online set default true,
  alter column available_online set not null,
  alter column visible_in_menu set default true,
  alter column visible_in_menu set not null;

comment on column public.categories.available_online is
  'Whether the category is available on the online ordering surface.';

comment on column public.categories.visible_in_menu is
  'Whether the category is shown on the read-only online menu.';

create index if not exists categories_online_order_idx
  on public.categories (sort_order, name)
  where is_active = true and available_online = true;

create index if not exists categories_online_menu_idx
  on public.categories (sort_order, name)
  where is_active = true and visible_in_menu = true;
