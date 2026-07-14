-- Анализы для PWA «Таблетки». Всё с префиксом lab_*, изолировано от остального
-- проекта joto-bot и от pill_* — легко удаляется. Привязка к тому же коду
-- синхронизации, что и лекарства (pill_state.code).

create table if not exists public.lab_results (
  code        text not null,               -- код синхронизации устройства (как в pill_state)
  rid         text not null,               -- стабильный клиентский ключ дедупа: hash(date|analyte_key|value_text)
  test_date   date,                         -- дата взятия/выполнения анализа
  analyte     text not null,               -- отображаемое имя показателя, напр. «Гемоглобин»
  analyte_key text not null,               -- нормализованный ключ для группировки (lower, без лишних пробелов)
  value       double precision,            -- числовое значение (null для «положительно» и т.п.)
  value_text  text,                         -- значение как в бланке
  unit        text,                         -- единицы, напр. «г/л»
  ref_low     double precision,            -- нижняя граница нормы (если есть)
  ref_high    double precision,            -- верхняя граница нормы (если есть)
  ref_text    text,                         -- референс как в бланке
  source      text not null default 'manual', -- 'manual' | 'gmail'
  created_at  timestamptz not null default now(),
  primary key (code, rid)
);
create index if not exists lab_results_code_key_idx on public.lab_results(code, analyte_key, test_date);
alter table public.lab_results enable row level security; -- доступ только через definer-функции

-- Массовое сохранение результатов (anon-вызов, как pill_save). Дедуп по (code, rid):
-- повторная загрузка того же бланка ничего не задваивает. Возвращает число вставленных строк.
create or replace function public.lab_save(p_code text, p_rows jsonb)
returns integer
language plpgsql security definer set search_path to 'public' as $$
declare
  n integer;
begin
  if p_code is null or length(trim(p_code)) = 0 then
    return 0;
  end if;
  with ins as (
    insert into public.lab_results
      (code, rid, test_date, analyte, analyte_key, value, value_text, unit, ref_low, ref_high, ref_text, source)
    select
      p_code,
      coalesce(nullif(r->>'rid',''), md5(coalesce(r->>'test_date','') || '|' || coalesce(r->>'analyte_key','') || '|' || coalesce(r->>'value_text',''))),
      nullif(r->>'test_date','')::date,
      coalesce(nullif(r->>'analyte',''), 'Показатель'),
      coalesce(nullif(r->>'analyte_key',''), lower(trim(coalesce(r->>'analyte','')))),
      (r->>'value')::double precision,
      r->>'value_text',
      r->>'unit',
      (r->>'ref_low')::double precision,
      (r->>'ref_high')::double precision,
      r->>'ref_text',
      coalesce(nullif(r->>'source',''), 'manual')
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as r
    on conflict (code, rid) do nothing
    returning 1
  )
  select count(*) into n from ins;
  return n;
end;
$$;

-- Загрузка всех результатов по коду, отсортировано для отрисовки графиков.
create or replace function public.lab_load(p_code text)
returns setof public.lab_results
language sql security definer set search_path to 'public' as $$
  select * from public.lab_results
  where code = p_code
  order by analyte_key, test_date nulls last, created_at;
$$;

-- Удаление одной записи (правка ошибочно распознанного показателя).
create or replace function public.lab_delete(p_code text, p_rid text)
returns void
language sql security definer set search_path to 'public' as $$
  delete from public.lab_results where code = p_code and rid = p_rid;
$$;

grant execute on function public.lab_save(text, jsonb)   to anon, authenticated;
grant execute on function public.lab_load(text)          to anon, authenticated;
grant execute on function public.lab_delete(text, text)  to anon, authenticated;
