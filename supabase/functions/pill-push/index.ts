// pill-push — отправляет Web Push напоминания о приёме лекарств.
// Вызывается раз в минуту по cron (pg_cron -> pg_net) с заголовком x-pill-secret.
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPA_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Локальное «настенное» время в IANA-таймзоне; при сбое — по смещению в минутах.
function localNow(tz: string, tzoff: number) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const o: Record<string, string> = {};
    for (const p of fmt.formatToParts(new Date())) o[p.type] = p.value;
    const hour = o.hour === '24' ? '00' : o.hour;
    return { date: `${o.year}-${o.month}-${o.day}`, minutes: (+hour) * 60 + (+o.minute) };
  } catch {
    const d = new Date(Date.now() - (tzoff || 0) * 60000);
    const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    return { date, minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }
}

function hm2min(t: string) { return (+t.slice(0, 2)) * 60 + (+t.slice(3, 5)); }

// Активно ли лекарство сегодня (повторяет логику клиента activeToday).
function activeOn(m: any, dateKey: string) {
  if (!m.days) return true;
  if (!m.start) return true;
  const start = Date.parse(m.start + 'T00:00:00Z');
  const now = Date.parse(dateKey + 'T00:00:00Z');
  const diff = Math.round((now - start) / 86400000);
  return diff >= 0 && diff < m.days;
}

Deno.serve(async (req) => {
  const supa = createClient(SUPA_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // конфиг (VAPID + секрет)
  const { data: cfgRows } = await supa.from('pill_config').select('k,v');
  const cfg: Record<string, string> = {};
  for (const r of cfgRows || []) cfg[r.k] = r.v;

  const secret = req.headers.get('x-pill-secret') || '';
  if (!cfg.cron_secret || secret !== cfg.cron_secret) {
    return new Response('forbidden', { status: 401 });
  }

  webpush.setVapidDetails(cfg.vapid_subject || 'mailto:admin@example.com', cfg.vapid_public, cfg.vapid_private);

  const { data: subs } = await supa.from('pill_push_sub').select('*');
  if (!subs || !subs.length) {
    return new Response(JSON.stringify({ ok: true, subs: 0 }), { headers: { 'content-type': 'application/json' } });
  }

  // расписания по кодам синхронизации
  const codes = [...new Set(subs.map((s: any) => s.code))];
  const { data: states } = await supa.from('pill_state').select('code,data').in('code', codes);
  const byCode: Record<string, any> = {};
  for (const s of states || []) byCode[s.code] = s.data || {};

  type Cand = { sub: any; fireKey: string; title: string; body: string };
  const cands: Cand[] = [];
  for (const sub of subs) {
    const data = byCode[sub.code];
    if (!data || !Array.isArray(data.meds)) continue;
    const log = data.log || {};
    const { date, minutes } = localNow(sub.tz, sub.tzoff);
    for (const m of data.meds) {
      if (!activeOn(m, date)) continue;
      for (const t of (m.times || [])) {
        // окно: время приёма наступило в последние 0..2 минуты (защита от дрожания cron)
        const delta = minutes - hm2min(t);
        if (delta < 0 || delta > 2) continue;
        const logKey = `${date}|${m.id}|${t}`;
        if (log[logKey]) continue; // уже отмечено как выпито
        cands.push({
          sub, fireKey: logKey,
          title: '💊 Пора принять: ' + (m.name || 'лекарство'),
          body: (m.dose || 'приём') + (m.note ? ' · ' + m.note : ''),
        });
      }
    }
  }

  // атомарный дедуп: вставляем (endpoint, fire_key); шлём только реально вставленные
  let sent = 0, removed = 0;
  if (cands.length) {
    const rows = cands.map((c) => ({ endpoint: c.sub.endpoint, fire_key: c.fireKey }));
    const { data: inserted } = await supa.from('pill_push_sent')
      .upsert(rows, { onConflict: 'endpoint,fire_key', ignoreDuplicates: true })
      .select('endpoint,fire_key');
    const fresh = new Set((inserted || []).map((r: any) => r.endpoint + '|' + r.fire_key));
    for (const c of cands) {
      if (!fresh.has(c.sub.endpoint + '|' + c.fireKey)) continue;
      const payload = JSON.stringify({ title: c.title, body: c.body, tag: c.fireKey, url: './' });
      try {
        await webpush.sendNotification(
          { endpoint: c.sub.endpoint, keys: { p256dh: c.sub.p256dh, auth: c.sub.auth } },
          payload, { TTL: 3600 },
        );
        sent++;
      } catch (err: any) {
        const sc = err?.statusCode;
        if (sc === 404 || sc === 410) { // подписка мертва — удаляем
          await supa.from('pill_push_sub').delete().eq('endpoint', c.sub.endpoint);
          removed++;
        } else {
          console.error('push error', sc, err?.body || err?.message);
        }
      }
    }
  }

  // чистим старые отметки об отправке
  await supa.from('pill_push_sent').delete().lt('created_at', new Date(Date.now() - 2 * 86400000).toISOString());

  return new Response(
    JSON.stringify({ ok: true, subs: subs.length, candidates: cands.length, sent, removed }),
    { headers: { 'content-type': 'application/json' } },
  );
});
