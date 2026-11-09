/* =====================================================================
   SMART AC MONITOR : ไฟล์กลาง (ทุกหน้าเรียกใช้ไฟล์นี้)
   1) ตั้งค่า  2) ดึงข้อมูลจาก ESP32  3) บันทึกค่า/เวลาเปิด-ปิดแอร์  4) วาดหน้าจอ
   ===================================================================== */

// รายชื่อแอร์ (อยากเปลี่ยนชื่อห้อง แก้ตรงนี้)
const CONFIG = { ACS: [{name:"แอร์ 1"},{name:"แอร์ 2"},{name:"แอร์ 3"},{name:"แอร์ 4"}] };
const STATE_TEXT = { on:"กำลังทำงาน", off:"ปิดอยู่", offline:"ออฟไลน์" };
const EV_TEXT = { on:"เปิดแอร์", off:"ปิดแอร์", offline:"ขาดการติดต่อ" };

// ค่าเริ่มต้น (แก้ได้ในหน้า "ตั้งค่า" ไม่ต้องมาแก้โค้ด)
//  refresh = อ่านค่าและอัปเดตหน้าจอทุกกี่วินาที   log = บันทึกค่าลงประวัติทุกกี่วินาที
//  onAmp   = กระแสตั้งแต่กี่แอมป์ถือว่าแอร์ "เปิด"   coolMax = อุณหภูมิลมออกที่ต้องไม่เกินกี่ °C
// url: ถ้าเปิดหน้าเว็บจาก ESP32 (http + ไม่ใช่ localhost) จะดึงข้อมูลที่ "/data" ให้อัตโนมัติ ไม่ต้องตั้งค่า
const FROM_ESP = location.protocol === "http:" && !["localhost","127.0.0.1"].includes(location.hostname);
const DEFAULTS = { refresh:5, log:60, url: FROM_ESP ? "/data" : "", onAmp:0.5, coolMax:28 };

/* ---------- เก็บข้อมูลในเครื่อง (localStorage) ---------- */
const store = {
  get(k, d){ try{ const v = JSON.parse(localStorage.getItem("sam_"+k)); return v==null ? d : v; }catch(e){ return d; } },
  set(k, v){ localStorage.setItem("sam_"+k, JSON.stringify(v)); }
};
const S = () => ({ ...DEFAULTS, ...store.get("settings", {}) });

/* ---------- ตัวช่วยจัดรูปแบบ ---------- */
const fmt  = (v, d) => (v==null || isNaN(v)) ? "--" : Number(v).toFixed(d);
const hms  = t => new Date(t).toLocaleTimeString("th-TH", {hour12:false});
const dmy  = t => new Date(t).toLocaleDateString("th-TH", {day:"2-digit", month:"short"});
const dur  = ms => { const m = Math.floor(ms/60000); return Math.floor(m/60) + " ชม. " + (m%60) + " นาที"; };
const every = s => (s>=60 && s%60===0) ? (s/60)+" นาที" : s+" วินาที";

/* ---------- ข้อมูลสาธิต (ใช้เมื่อยังไม่ใส่ URL ของ ESP32) ---------- */
const sim = [{on:1,t:27.2,e:120},{on:1,t:28.4,e:98},{on:0,t:31,e:75},{on:1,t:30.2,e:64}];
function demo(){
  return sim.map(s => {
    if (Math.random() < 0.01) s.on = !s.on;                       // สุ่มเปิด/ปิดบ้าง เพื่อทดสอบบันทึก
    const goal = s.on ? 27.5 : 31;
    s.t += (goal - s.t)*0.08 + (Math.random()-.5)*0.2;
    const p = s.on ? 1150 + Math.random()*30 : 3;
    s.e += p/3.6e6*5;
    return { temp:s.t, voltage:220+Math.random()*4-2, current:s.on?5.5+Math.random()*.4:0.02, power:p, energy:s.e, freq:50, pf:s.on?0.92:0.3 };
  });
}

/* ---------- ดึงข้อมูล: ESP32 ต้องตอบ JSON เป็น {"acs":[{temp,voltage,current,power,energy,freq,pf} x4]} ---------- */
async function loadAll(){
  const s = S(); let raw;
  if (!s.url) raw = demo();
  else { try{ const r = await fetch(s.url, {cache:"no-store"}); const j = await r.json(); raw = j.acs || j; }catch(e){ raw = []; } }
  return CONFIG.ACS.map((a, i) => {
    const d = raw[i];
    if (!d) return { state:"offline", data:{}, warnings:[a.name+": ติดต่อ ESP32 ไม่ได้"] };
    const on = (d.current||0) >= s.onAmp;                         // แอร์เปิดหรือไม่ ดูจากกระแส
    const w = [];
    // ทำงานแต่ลมออกยังไม่เย็น (หมายเหตุ: ช่วงเพิ่งเปิดใหม่ ๆ อาจเตือนชั่วคราว)
    if (on && d.temp > s.coolMax) w.push(`${a.name}: ทำงานอยู่แต่อุณหภูมิ ${fmt(d.temp,1)}°C ยังสูงกว่า ${s.coolMax}°C (อาจไม่เย็น)`);
    return { state:on?"on":"off", data:d, warnings:w };
  });
}

/* ---------- บันทึก: (1) เวลาเปิด/ปิดเมื่อสถานะเปลี่ยน (2) ค่าอุณหภูมิ/แรงดัน/กระแส ทุกรอบที่ตั้งไว้ ---------- */
function track(res){
  const s = S(), now = Date.now();
  const ev = store.get("events", []), last = store.get("last", []), rows = store.get("rows", []);
  // ต่อ ESP32 อยู่: ประวัติเปิด-ปิดมาจาก ESP32 (ดู syncEvents) / โหมดสาธิต: จดในเครื่องนี้
  if (!s.url) res.forEach((r, i) => { if (last[i] !== r.state){ ev.push({i, s:r.state, t:now}); last[i] = r.state; } });
  const keep = now - 48*3600*1000;                       // เก็บ 48 ชั่วโมง เกินแล้วลบทิ้ง
  store.set("events", ev.filter(e => e.t >= keep).slice(-1000)); store.set("last", last);
  if (now - store.get("lastLog", 0) >= s.log*1000){
    res.forEach((r, i) => { if (r.state !== "offline") rows.push({t:now, i, c:r.data.temp, v:r.data.voltage, a:r.data.current}); });
    store.set("rows", rows.filter(x => x.t >= keep).slice(-5000)); store.set("lastLog", now);
  }
}
// ดึงประวัติเปิด-ปิดจาก ESP32 (ทุกเครื่องเห็นชุดเดียวกัน) มาเก็บแทนของเดิมในเครื่อง
async function syncEvents(){
  const s = S(); if (!s.url) return;
  try{
    const r = await fetch(s.url.replace(/\/data$/, "/events"), {cache:"no-store"}); const j = await r.json();
    store.set("events", j.events.map(e => ({i:e.i, s:e.s, t:e.t*1000})));
  }catch(e){}
}
const lastAt = (i, st) => { const e = store.get("events", []).filter(e => e.i===i && e.s===st).pop(); return e ? hms(e.t) : "—"; };
function runtimeToday(i){                                          // เวลาที่แอร์เปิดรวมของวันนี้
  const st = new Date().setHours(0,0,0,0); let ms = 0, from = null;
  store.get("events", []).filter(e => e.i===i).forEach(e => {
    const t = Math.max(e.t, st);
    if (e.s === "on"){ if (from == null) from = t; } else if (from != null){ ms += t - from; from = null; }
  });
  if (from != null) ms += Date.now() - from;
  return ms;
}
function csv(name, head, rows){
  const txt = "\ufeff" + [head, ...rows].map(r => r.join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([txt], {type:"text/csv"})); a.download = name; a.click();
}

/* ---------- วาดหน้าจอ ---------- */
const ico = p => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const IC = {
  home:'<path d="M3 11l9-8 9 8v10H3z"/>',
  ac:'<rect x="3" y="5" width="18" height="8" rx="2"/><path d="M7 17v2M12 17v3M17 17v2"/>',
  log:'<path d="M5 4h14v16H5zM9 9h6M9 13h6"/>',
  room:'<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
  set:'<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>'
};
function shell(page, n){
  const a = (h, ic, t, on, x="") => `<a href="${h}" class="${on?"active":""}">${ico(IC[ic])}<span>${t}</span>${x}</a>`;
  document.getElementById("app").innerHTML = `
    <nav class="side">
      <div class="brand"><b>SMART AC</b><small>MONITOR</small></div>
      ${a("index.html","home","ภาพรวม",page==="home")}
      <em class="grp">เครื่องปรับอากาศ</em>
      ${CONFIG.ACS.map((x,i) => a(`ac${i+1}.html`,"ac",x.name,page==="ac"&&n===i+1,`<i class="dot" id="dot${i+1}"></i>`)).join("")}
      <em class="grp">มุมมองห้อง</em>
      ${a("room.html","room","ห้อง 3 มิติ",page==="room")}
      <em class="grp">ระบบ</em>
      ${a("log.html","log","บันทึก",page==="log")}
      ${a("settings.html","set","ตั้งค่า",page==="set")}
    </nav>
    <div class="scrim" id="scrim"></div>
    <main class="main">
      <div class="mbar"><button id="mb" aria-label="เมนู">${ico('<path d="M4 7h16M4 12h16M4 17h16"/>')}</button><b>SMART AC MONITOR</b></div>
      <div id="content"></div></main>`;
  // เมนูมือถือ: กด ☰ เปิด/ปิด, กดฉากมืดหรือกดลิงก์เมนูแล้วปิด
  const tog = () => document.body.classList.toggle("nav-open");
  document.body.classList.remove("nav-open");
  document.getElementById("mb").onclick = tog;
  document.getElementById("scrim").onclick = tog;
  document.querySelectorAll(".side a").forEach(l => l.onclick = () => document.body.classList.remove("nav-open"));
}
const head = (t, sub, chip=true, back=true) => (back ? `<a class="back" href="index.html">← กลับหน้าหลัก</a>` : "") + `<div class="top"><div><h1>${t}</h1><p>${sub}</p></div>
  ${chip ? `<div class="chip">อัปเดตล่าสุด <b class="num">${hms(Date.now())}</b> · ทุก ${every(S().refresh)}</div>` : ""}</div>`;
const alerts = res => { const w = res.flatMap(r => r.warnings); return w.length ? `<div class="alerts"><b>แจ้งเตือน</b><br>${w.join("<br>")}</div>` : ""; };

function card(r, i){
  const d = r.data;
  return `<a class="ac ${r.state}" href="ac${i+1}.html">
    <div class="ac-head"><h2>${CONFIG.ACS[i].name}</h2><span class="pill ${r.state}">${STATE_TEXT[r.state]}</span></div>
    <div class="temp">${fmt(d.temp,1)}<small>°C</small></div>
    <div class="meta"><span>แรงดัน <b class="num">${fmt(d.voltage,0)}</b> V</span><span>กระแส <b class="num">${fmt(d.current,2)}</b> A</span><span>กำลัง <b class="num">${fmt(d.power,0)}</b> W</span></div>
    <div class="times"><span>เปิดล่าสุด <b class="num">${lastAt(i,"on")}</b></span><span>ปิดล่าสุด <b class="num">${lastAt(i,"off")}</b></span></div></a>`;
}
function viewHome(res){
  const c = s => res.filter(r => r.state===s).length;
  const st = (t, v, k="") => `<div class="stat ${k}"><span>${t}</span><strong>${v}</strong></div>`;
  return head("ภาพรวมเครื่องปรับอากาศ","สถานะ อุณหภูมิ แรงดัน และกระแสของแอร์ทุกตัว", true, false) + alerts(res) +
    `<div class="stats">${st("แอร์ทั้งหมด",res.length)}${st("เปิดอยู่",c("on"),"on")}${st("ปิดอยู่",c("off"),"off")}${st("ออฟไลน์",c("offline"),"offline")}</div>
     <a class="room-btn" href="room.html">${ico(IC.room).replace('width="20" height="20"','width="34" height="34"')}
       <div><b>ดูห้องเรียนแบบ 3 มิติ</b><small>หมุน ซูม ดูตำแหน่งแอร์ทั้ง 4 ตัวพร้อมสถานะสด</small></div><span class="go">เปิดดู</span></a>
     <div class="grid">${res.map(card).join("")}</div>`;
}
function viewRoom(){
  document.title = "ห้อง 3 มิติ - SMART AC MONITOR";
  return head("ห้องเรียน 3 มิติ","ลากเพื่อหมุน บีบหรือเลื่อนล้อเพื่อซูม ป้าย Air 1-4 แสดงสถานะสดของแอร์", false) +
    `<iframe class="room" id="room3d" title="ห้องเรียน 3 มิติ"></iframe>`;
}
// ส่งสถานะแอร์ (เปิด/ปิด/ออฟไลน์ + อุณหภูมิ) เข้าไปให้ตัวดู 3 มิติอัปเดตป้าย
function roomSend(fr, res){
  if (fr && fr.contentWindow) fr.contentWindow.postMessage({type:"ac", acs:res.map(x => ({state:x.state, temp:x.data.temp}))}, "*");
}
function evRows(list){
  return list.length ? `<table><tr><th>แอร์</th><th>เหตุการณ์</th><th>วันที่</th><th>เวลา</th></tr>` +
    list.map(e => `<tr><td>${CONFIG.ACS[e.i].name}</td><td><span class="pill ${e.s}">${EV_TEXT[e.s]}</span></td><td>${dmy(e.t)}</td><td class="num">${hms(e.t)}</td></tr>`).join("") + `</table>`
    : `<div class="empty">ยังไม่มีบันทึก (จะบันทึกอัตโนมัติเมื่อแอร์เปิดหรือปิด)</div>`;
}
function viewAC(res, n){
  const i = n-1, r = res[i], d = r.data;
  const evs = store.get("events", []).filter(e => e.i===i).slice(-10).reverse();
  document.title = CONFIG.ACS[i].name + " - SMART AC MONITOR";
  return head(CONFIG.ACS[i].name,"รายละเอียดการทำงานของเครื่องปรับอากาศ") + alerts(res.filter((_,k)=>k===i)) +
   `<div class="hero ${r.state}"><div><span class="pill ${r.state}">${STATE_TEXT[r.state]}</span></div>
      <div><div class="temp">${fmt(d.temp,1)}<small>°C</small></div><small class="l">อุณหภูมิลมออก</small></div></div>
    <div class="tiles">
      <div class="tile"><span>แรงดัน</span><strong>${fmt(d.voltage,1)} <small>V</small></strong></div>
      <div class="tile"><span>กระแส</span><strong>${fmt(d.current,2)} <small>A</small></strong></div>
      <div class="tile"><span>กำลังไฟ</span><strong>${fmt(d.power,0)} <small>W</small></strong></div></div>
    <div class="two">
      <div class="card"><h3>เวลาเปิด-ปิด</h3>
        <div class="row"><span>เปิดล่าสุดเวลา</span><b class="num">${lastAt(i,"on")}</b></div>
        <div class="row"><span>ปิดล่าสุดเวลา</span><b class="num">${lastAt(i,"off")}</b></div>
        <div class="row"><span>เปิดรวมวันนี้</span><b>${dur(runtimeToday(i))}</b></div></div>
      <div class="card"><h3>ข้อมูลไฟฟ้าเพิ่มเติม</h3>
        <div class="row"><span>พลังงานสะสม</span><b class="num">${fmt(d.energy,2)} kWh</b></div>
        <div class="row"><span>ความถี่</span><b class="num">${fmt(d.freq,1)} Hz</b></div>
        <div class="row"><span>Power Factor</span><b class="num">${fmt(d.pf,2)}</b></div></div></div>
    <div class="card"><h3>ประวัติเปิด-ปิด (10 รายการล่าสุด)</h3>${evRows(evs)}</div>`;
}
function viewLog(){
  const evs = store.get("events", []).slice(-60).reverse();
  const rows = store.get("rows", []).slice(-15).reverse();
  const rt = rows.length ? `<table><tr><th>เวลา</th><th>แอร์</th><th>อุณหภูมิ</th><th>แรงดัน</th><th>กระแส</th></tr>` +
    rows.map(x => `<tr><td class="num">${hms(x.t)}</td><td>${CONFIG.ACS[x.i].name}</td><td class="num">${fmt(x.c,1)} °C</td><td class="num">${fmt(x.v,1)} V</td><td class="num">${fmt(x.a,2)} A</td></tr>`).join("") + `</table>`
    : `<div class="empty">ยังไม่มีค่าที่บันทึก (บันทึกทุก ${every(S().log)})</div>`;
  return head("บันทึกข้อมูล","ประวัติเวลาเปิด-ปิดแอร์ และค่าที่บันทึกตามรอบเวลา") +
    `<div class="btns"><button class="main-btn" id="x1">ดาวน์โหลดเปิด-ปิด (CSV)</button><button class="main-btn" id="x2">ดาวน์โหลดค่าที่บันทึก (CSV)</button><button class="danger" id="x3">ล้างประวัติ</button></div>
     <div class="card"><h3>เวลาเปิด-ปิดแอร์</h3>${evRows(evs)}<div class="empty">${S().url ? "ข้อมูลจาก ESP32 · ทุกเครื่องเห็นชุดเดียวกัน · เก็บ 48 ชั่วโมงแล้วลบอัตโนมัติ" : "โหมดสาธิต: เก็บในเครื่องนี้ 48 ชั่วโมง แล้วลบอัตโนมัติ"}</div></div>
     <div class="card"><h3>ค่าที่บันทึกล่าสุด (ทุก ${every(S().log)})</h3>${rt}</div>`;
}
function bindLog(){
  document.getElementById("x1").onclick = () => csv("ac_events.csv", ["แอร์","เหตุการณ์","วันที่เวลา"],
    store.get("events",[]).map(e => [CONFIG.ACS[e.i].name, EV_TEXT[e.s], new Date(e.t).toLocaleString("th-TH")]));
  document.getElementById("x2").onclick = () => csv("ac_readings.csv", ["วันที่เวลา","แอร์","อุณหภูมิ(C)","แรงดัน(V)","กระแส(A)"],
    store.get("rows",[]).map(x => [new Date(x.t).toLocaleString("th-TH"), CONFIG.ACS[x.i].name, fmt(x.c,1), fmt(x.v,1), fmt(x.a,2)]));
  document.getElementById("x3").onclick = () => { if (confirm("ล้างประวัติที่เก็บในเครื่องนี้? (ประวัติเปิด-ปิดจาก ESP32 จะถูกดึงมาใหม่)")){ ["events","rows","last","lastLog"].forEach(k => localStorage.removeItem("sam_"+k)); location.reload(); } };
}

/* ---------- หน้าตั้งค่า ---------- */
function viewSettings(){
  const s = S();
  const pair = (id, label, v, hint) => { const m = v>=60 && v%60===0;
    return `<label class="f"><span>${label}</span><div class="pair"><input type="number" min="1" id="${id}" value="${m?v/60:v}">
      <select id="${id}U"><option value="1" ${m?"":"selected"}>วินาที</option><option value="60" ${m?"selected":""}>นาที</option></select></div><small>${hint}</small></label>`; };
  const one = (id, label, v, hint) => `<label class="f"><span>${label}</span><input id="${id}" value="${v}"><small>${hint}</small></label>`;
  document.title = "ตั้งค่า - SMART AC MONITOR";
  document.getElementById("content").innerHTML = head("ตั้งค่า","กำหนดรอบเวลาอ่านค่า รอบบันทึก และเกณฑ์ตัดสินสถานะ", false) +
    `<div class="card form">
      ${pair("refresh","อ่านและแสดงค่า อุณหภูมิ แรงดัน กระแส ทุก",s.refresh,"รอบที่หน้าจอดึงค่าจาก ESP32 มาแสดง")}
      ${pair("log","บันทึกอุณหภูมิ แรงดัน กระแส ของแต่ละห้อง ทุก",s.log,"รอบที่เก็บค่าลงประวัติ (ดูได้ที่หน้าบันทึก)")}
      ${one("url","ที่อยู่ข้อมูล ESP32 (URL)",s.url,"เช่น http://192.168.1.50/data  ถ้าเว้นว่างจะแสดงข้อมูลสาธิต")}
      ${one("onAmp","กระแสที่ถือว่าแอร์เปิด (แอมป์)",s.onAmp,"กระแสตั้งแต่ค่านี้ขึ้นไป = แอร์ทำงาน")}
      ${one("coolMax","อุณหภูมิลมออกสูงสุดที่ยอมรับ (°C)",s.coolMax,"แอร์เปิดอยู่แต่อุณหภูมิสูงกว่านี้ = แจ้งเตือนว่าไม่เย็น")}
      <button class="main-btn" id="save">บันทึกการตั้งค่า</button><span id="msg"></span></div>`;
  const sec = id => Math.max(1, Math.round(+document.getElementById(id).value * +document.getElementById(id+"U").value)) || 1;
  document.getElementById("save").onclick = () => {
    store.set("settings", { refresh:sec("refresh"), log:sec("log"), url:document.getElementById("url").value.trim(),
      onAmp:+document.getElementById("onAmp").value || DEFAULTS.onAmp, coolMax:+document.getElementById("coolMax").value || DEFAULTS.coolMax });
    document.getElementById("msg").textContent = "บันทึกแล้ว ✓";
  };
}

/* ---------- เริ่มทำงาน ---------- */
let timer;
async function boot(){
  const p = document.body.dataset.page, n = +document.body.dataset.ac;
  shell(p, n); window.scrollTo(0, 0);
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js");
  if (p === "set"){ viewSettings(); return; }
  let last = [];
  if (p === "room"){                       // หน้า 3 มิติ: วาดกรอบครั้งเดียว แล้วส่งสถานะเข้าไปทุกรอบ
    document.getElementById("content").innerHTML = viewRoom();
    const fr = document.getElementById("room3d");
    if (typeof ROOM_HTML !== "undefined") fr.srcdoc = ROOM_HTML; else fr.src = "room3d.html";
    fr.onload = () => roomSend(fr, last);
  }
  const tick = async () => {
    const res = await loadAll(); await syncEvents(); track(res); last = res;
    if (p === "room") roomSend(document.getElementById("room3d"), res);
    else {
      document.getElementById("content").innerHTML = p==="home" ? viewHome(res) : p==="ac" ? viewAC(res, n) : viewLog();
      if (p === "log") bindLog();
    }
    res.forEach((r, i) => { const el = document.getElementById("dot"+(i+1)); if (el) el.className = "dot " + r.state; });
  };
  tick(); timer = setInterval(tick, S().refresh*1000);
}
boot();
