// lab-ingest — серверная «приёмная» анализов из почты (Фаза 2).
// Получает письма (текст + вложения PDF/фото), разбирает их через Claude и
// кладёт показатели в public.lab_results под кодом синхронизации пользователя.
// Вызывается из Google Apps Script (POST + заголовок x-lab-secret).
//
// Тело запроса:
//   { "code": "pill-xxxx",
//     "messages": [
//       { "id": "gmail-msg-id", "date": "2026-05-12", "subject": "...",
//         "from": "...", "text": "тело письма",
//         "attachments": [ { "filename": "result.pdf",
//                            "mimeType": "application/pdf", "dataB64": "..." } ] }
//     ] }
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPA_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// --- дедуп-ключ и нормализация: ТОЧНО как в браузере (index.html) ---
function hashRid(s: string): string {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
function normKey(name: string): string {
  return String(name || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[«»\.,;:()]/g, ' ').replace(/\s+/g, ' ').trim();
}
function labNum(x: unknown): number | null {
  if (x === null || x === undefined || x === '') return null;
  const v = typeof x === 'number' ? x : parseFloat(String(x).replace(',', '.'));
  return isFinite(v) ? v : null;
}

const SYS = "Ты извлекаешь результаты медицинских лабораторных анализов (например, лаборатория Гемотест) из текста, PDF или фото бланка. Верни СТРОГО JSON-массив без markdown и пояснений. Каждый элемент — один показатель: {\"test_date\":\"YYYY-MM-DD или null\",\"analyte\":\"название по-русски, напр. Гемоглобин\",\"value\":число или null,\"value_text\":\"значение как в бланке\",\"unit\":\"единицы или пустая строка\",\"ref_low\":число или null,\"ref_high\":число или null,\"ref_text\":\"референс как в бланке или пустая строка\"}. Правила: извлекай ВСЕ показатели с числовыми значениями. Десятичный разделитель — точка. test_date — дата взятия биоматериала (одна на бланк, если общая); если в документе даты нет, используй дату письма из подсказки. Референс «до 5.0» → ref_high=5.0, ref_low=null; «> 1.03» → ref_low=1.03; «13.0 - 17.0» → ref_low=13.0, ref_high=17.0. Если это НЕ бланк анализов — верни пустой массив []. Ничего не выдумывай. Отвечай только JSON-массивом.";

async function extract(msg: any, apiKey: string): Promise<any[]> {
  const blocks: any[] = [];
  for (const a of (msg.attachments || [])) {
    if (!a?.dataB64) continue;
    const mt = a.mimeType || '';
    if (mt === 'application/pdf') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.dataB64 } });
    } else if (mt.startsWith('image/')) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mt, data: a.dataB64 } });
    }
  }
  const hint = [
    msg.date ? `Дата письма: ${msg.date}.` : '',
    msg.subject ? `Тема: ${msg.subject}.` : '',
    msg.text ? `\n\nТекст письма:\n${String(msg.text).slice(0, 20000)}` : '',
  ].filter(Boolean).join(' ');
  blocks.push({ type: 'text', text: (hint || '') + '\n\nИзвлеки все показатели анализа как JSON-массив.' });

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 4096, temperature: 0, system: SYS, messages: [{ role: 'user', content: blocks }] }),
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('anthropic ' + r.status + ' ' + t.slice(0, 160)); }
  const j = await r.json();
  const txt = (j.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
  const mm = txt.match(/\[[\s\S]*\]/);
  if (!mm) return [];
  const arr = JSON.parse(mm[0]);
  return Array.isArray(arr) ? arr : [];
}

function toRow(o: any) {
  const name = String(o.analyte || '').trim() || 'Показатель';
  const val = labNum(o.value);
  const vt = (o.value_text != null && o.value_text !== '') ? String(o.value_text).trim() : (val != null ? String(val) : '');
  const key = normKey(name);
  const date = (o.test_date && /^\d{4}-\d{2}-\d{2}$/.test(o.test_date)) ? o.test_date : null;
  const rid = hashRid((date || '') + '|' + key + '|' + vt);
  return {
    rid, test_date: date, analyte: name, analyte_key: key, value: val, value_text: vt,
    unit: String(o.unit || '').trim(), ref_low: labNum(o.ref_low), ref_high: labNum(o.ref_high),
    ref_text: String(o.ref_text || '').trim(), source: 'gmail',
  };
}

Deno.serve(async (req) => {
  const supa = createClient(SUPA_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { data: cfgRows } = await supa.from('pill_config').select('k,v');
  const cfg: Record<string, string> = {};
  for (const r of cfgRows || []) cfg[r.k] = r.v;

  // авторизация общим секретом
  const secret = req.headers.get('x-lab-secret') || '';
  if (!cfg.lab_ingest_secret || secret !== cfg.lab_ingest_secret) {
    return new Response('forbidden', { status: 401 });
  }
  if (!cfg.lab_anthropic_key) {
    return new Response(JSON.stringify({ ok: false, error: 'lab_anthropic_key не настроен' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const code = String(body.code || '').trim();
  const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
  if (!code) return new Response(JSON.stringify({ ok: false, error: 'нет code' }), { status: 400, headers: { 'content-type': 'application/json' } });

  // отсеиваем уже обработанные письма
  const ids = messages.map((m) => String(m.id || '')).filter(Boolean);
  const seen = new Set<string>();
  if (ids.length) {
    const { data: seenRows } = await supa.from('lab_ingest_seen').select('msg_id').eq('code', code).in('msg_id', ids);
    for (const r of seenRows || []) seen.add(r.msg_id);
  }

  let processed = 0, inserted = 0, skipped = 0;
  const errors: string[] = [];

  for (const msg of messages) {
    const id = String(msg.id || '');
    if (id && seen.has(id)) { skipped++; continue; }
    try {
      const raw = await extract(msg, cfg.lab_anthropic_key);
      const rows = raw.map(toRow).filter((r) => r.value_text !== '').map((r) => ({ code, ...r }));
      if (rows.length) {
        const { data: ins } = await supa.from('lab_results')
          .upsert(rows, { onConflict: 'code,rid', ignoreDuplicates: true })
          .select('rid');
        inserted += (ins || []).length;
      }
      if (id) await supa.from('lab_ingest_seen').upsert({ code, msg_id: id, n_rows: rows.length }, { onConflict: 'code,msg_id', ignoreDuplicates: false });
      processed++;
    } catch (e: any) {
      errors.push(id + ': ' + (e?.message || String(e)).slice(0, 120));
    }
  }

  return new Response(
    JSON.stringify({ ok: true, code, received: messages.length, processed, skipped, inserted, errors }),
    { headers: { 'content-type': 'application/json' } },
  );
});
