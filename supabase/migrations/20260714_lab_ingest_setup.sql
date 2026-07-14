-- Приём анализов из почты (Фаза 2). Серверная «приёмная» lab-ingest получает
-- письма (текст + вложения), разбирает их через Claude и кладёт показатели в
-- lab_results. Эта таблица помнит уже обработанные письма, чтобы не разбирать
-- одно и то же письмо каждый час (экономия токенов ИИ).

create table if not exists public.lab_ingest_seen (
  code       text not null,               -- код синхронизации, к которому привязан ящик
  msg_id     text not null,               -- идентификатор письма из Gmail
  n_rows     integer not null default 0,  -- сколько показателей извлечено (для диагностики)
  created_at timestamptz not null default now(),
  primary key (code, msg_id)
);
create index if not exists lab_ingest_seen_created_idx on public.lab_ingest_seen(created_at);
alter table public.lab_ingest_seen enable row level security; -- доступ только через service role (edge-функция)

-- Секреты приёмной (ключ Anthropic для серверного разбора + общий секрет эндпоинта)
-- хранятся в pill_config под ключами lab_anthropic_key / lab_ingest_secret и в гит НЕ попадают:
--   insert into public.pill_config(k,v) values
--     ('lab_ingest_secret','...'), ('lab_anthropic_key','sk-ant-...')
--   on conflict (k) do update set v = excluded.v;
