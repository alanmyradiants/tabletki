-- Web Push для PWA «Таблетки». Всё с префиксом pill_*, изолировано от
-- остального проекта joto-bot и легко удаляется.
-- ПРИМЕНЕНО к проекту ssjghfivizubznkrdgxi через MCP apply_migration.

create table if not exists public.pill_config (
  k text primary key,
  v text not null
);
alter table public.pill_config enable row level security; -- доступ только через service role / definer

create table if not exists public.pill_push_sub (
  id bigint generated always as identity primary key,
  code text not null,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  tz text not null default 'UTC',
  tzoff integer not null default 0,
  ua text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pill_push_sub_code_idx on public.pill_push_sub(code);
alter table public.pill_push_sub enable row level security;

create table if not exists public.pill_push_sent (
  endpoint text not null,
  fire_key text not null,
  created_at timestamptz not null default now(),
  primary key (endpoint, fire_key)
);
create index if not exists pill_push_sent_created_idx on public.pill_push_sent(created_at);
alter table public.pill_push_sent enable row level security;

-- Клиент регистрирует/обновляет свою push-подписку (anon-вызов, как pill_save).
create or replace function public.pill_push_register(
  p_code text, p_endpoint text, p_p256dh text, p_auth text,
  p_tz text default 'UTC', p_tzoff integer default 0, p_ua text default null
) returns void
language sql security definer set search_path to 'public' as $$
  insert into public.pill_push_sub(code, endpoint, p256dh, auth, tz, tzoff, ua, updated_at)
  values (p_code, p_endpoint, p_p256dh, p_auth, coalesce(p_tz,'UTC'), coalesce(p_tzoff,0), p_ua, now())
  on conflict (endpoint) do update set
    code = excluded.code, p256dh = excluded.p256dh, auth = excluded.auth,
    tz = excluded.tz, tzoff = excluded.tzoff, ua = excluded.ua, updated_at = now();
$$;

create or replace function public.pill_push_unregister(p_endpoint text)
returns void
language sql security definer set search_path to 'public' as $$
  delete from public.pill_push_sub where endpoint = p_endpoint;
$$;

grant execute on function public.pill_push_register(text,text,text,text,text,integer,text) to anon, authenticated;
grant execute on function public.pill_push_unregister(text) to anon, authenticated;

-- VAPID-ключи и cron-секрет пишутся в pill_config отдельно (значения не в гите):
--   insert into public.pill_config(k,v) values ('vapid_public', '...'), ('vapid_private', '...'),
--     ('vapid_subject', 'mailto:...'), ('cron_secret', '...')
--   on conflict (k) do update set v = excluded.v;

-- Запуск отправщика раз в минуту (выполнить ПОСЛЕ деплоя функции pill-push):
--   create extension if not exists pg_cron;
--   select cron.schedule('pill-push-every-min', '* * * * *', $cron$
--     select net.http_post(
--       url     => 'https://ssjghfivizubznkrdgxi.supabase.co/functions/v1/pill-push',
--       headers => jsonb_build_object('content-type','application/json',
--                  'x-pill-secret', (select v from public.pill_config where k='cron_secret')),
--       body    => '{}'::jsonb
--     );
--   $cron$);
