// เก็บไฟล์ไว้ในเครื่อง ให้เปิดแอปได้แม้เน็ตหลุด (ดึงใหม่จากเน็ตก่อน ถ้าไม่ได้ค่อยใช้ของที่เก็บไว้)
const C="sam-v1";
self.addEventListener("install",e=>{self.skipWaiting();e.waitUntil(caches.open(C).then(c=>c.addAll(["index.html","ac1.html","ac2.html","ac3.html","ac4.html","log.html","room.html","room3d.html","settings.html","style.css","config.js","icon.svg"])))});
self.addEventListener("fetch",e=>{
  if(new URL(e.request.url).origin!==location.origin) return;   // ข้อมูลจาก ESP32 ไม่เก็บแคช
  e.respondWith(fetch(e.request).then(r=>{const k=r.clone();caches.open(C).then(c=>c.put(e.request,k));return r}).catch(()=>caches.match(e.request)));
});
