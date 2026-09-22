const CACHE='pills-v7';
const ASSETS=['./','./index.html','./manifest.json','./icon.svg'];
self.addEventListener('install',e=>{
  self.skipWaiting();
  // cache:'reload' — иначе в запас кладётся копия из старого кэша браузера,
  // и при слабой сети приложение откатывается на неё.
  e.waitUntil(caches.open(CACHE).then(c=>
    Promise.all(ASSETS.map(u=>fetch(new Request(u,{cache:'reload'}))
      .then(r=>r.ok?c.put(u,r):null).catch(()=>null)))
  ).catch(()=>{}));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const req=e.request;
  const isHTML = req.mode==='navigate' || (req.headers.get('accept')||'').includes('text/html');
  if(isHTML){
    // network-first: страница всегда грузится свежая, если есть интернет
    e.respondWith(
      fetch(req).then(resp=>{
        // свежую страницу кладём и под свой адрес, и под './index.html',
        // чтобы запасная копия никогда не была старее показанной
        const cp=resp.clone(), cp2=resp.clone();
        caches.open(CACHE).then(c=>{c.put(req,cp);c.put('./index.html',cp2);}).catch(()=>{});
        return resp;
      }).catch(()=>caches.match(req).then(r=>r||caches.match('./index.html')))
    );
  } else {
    // cache-first для статических файлов
    e.respondWith(
      caches.match(req).then(r=>r||fetch(req).then(resp=>{const cp=resp.clone();caches.open(CACHE).then(c=>c.put(req,cp)).catch(()=>{});return resp;}))
    );
  }
});
// Web Push: сервер шлёт напоминание, даже когда приложение закрыто
self.addEventListener('push',e=>{
  let d={};
  try{ d=e.data?e.data.json():{}; }
  catch(_){ d={title:'💊 Напоминание', body:(e.data&&e.data.text&&e.data.text())||''}; }
  const title=d.title||'💊 Напоминание';
  e.waitUntil(self.registration.showNotification(title,{
    body:d.body||'', icon:'icon.svg', badge:'icon.svg',
    vibrate:[80,40,80], tag:d.tag, renotify:!!d.tag, data:{url:d.url||'./'}
  }));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const url=(e.notification.data&&e.notification.data.url)||'./';
  e.waitUntil(clients.matchAll({type:'window'}).then(cl=>{
    for(const c of cl){if('focus'in c)return c.focus();}
    if(clients.openWindow)return clients.openWindow(url);
  }));
});
