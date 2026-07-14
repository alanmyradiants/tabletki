/**
 * Tabletki — автосинхронизация анализов Гемотест из Gmail в бота.
 *
 * НАСТРОЙКА (~5 минут):
 *  1. Открой https://script.google.com → «Новый проект».
 *  2. Вставь весь этот код.
 *  3. Заполни CODE (код синхронизации из бота: раздел «Ещё») и SECRET (дам в чате).
 *  4. Меню «Выполнить» → функция syncLabs → разреши доступ к Gmail (от своего имени).
 *  5. «Триггеры» (часы слева) → добавить триггер: syncLabs, «по времени», каждый час.
 *
 * Скрипт раз в час находит письма Гемотеста, отправляет их (текст + PDF/фото) в
 * приёмную бота, а обработанные помечает меткой, чтобы не слать повторно. Так он
 * постепенно разберёт всю историю писем и будет подхватывать новые.
 */

const ENDPOINT = 'https://ssjghfivizubznkrdgxi.supabase.co/functions/v1/lab-ingest';
const SECRET   = 'ВСТАВЬ_СЕКРЕТ_ИЗ_ЧАТА';
const CODE     = 'ВСТАВЬ_КОД_СИНХРОНИЗАЦИИ_ИЗ_БОТА';

// Письма от лаборатории Гемотест (отправитель info@gemotest.ru; срочные результаты
// приходят отдельным письмом с того же домена). has:attachment — только с вложениями.
const QUERY = 'from:gemotest.ru has:attachment';
const LABEL = 'tabletki-обработано';
const BATCH = 8; // писем за один запуск (защита от лимитов Apps Script)

function syncLabs() {
  const done = GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
  const threads = GmailApp.search(QUERY + ' -label:"' + LABEL + '"', 0, BATCH);
  if (!threads.length) { Logger.log('нет новых писем'); return; }

  const messages = [];
  threads.forEach(function (th) {
    th.getMessages().forEach(function (m) {
      const atts = [];
      m.getAttachments({ includeInlineImages: false }).forEach(function (a) {
        const mt = a.getContentType();
        if (mt === 'application/pdf' || mt.indexOf('image/') === 0) {
          atts.push({ filename: a.getName(), mimeType: mt, dataB64: Utilities.base64Encode(a.getBytes()) });
        }
      });
      messages.push({
        id: m.getId(),
        date: Utilities.formatDate(m.getDate(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
        subject: m.getSubject(),
        from: m.getFrom(),
        text: m.getPlainBody().slice(0, 20000),
        attachments: atts,
      });
    });
  });

  const res = UrlFetchApp.fetch(ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-lab-secret': SECRET },
    payload: JSON.stringify({ code: CODE, messages: messages }),
    muteHttpExceptions: true,
  });
  Logger.log(res.getResponseCode() + ' ' + res.getContentText());
  if (res.getResponseCode() === 200) {
    threads.forEach(function (th) { th.addLabel(done); });
  }
}
