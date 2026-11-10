// Playwright + mock Firebase: วัดจำนวน record ที่ถูกดึง และพฤติกรรมของหน้า realtime / history / dashboard / vehicle-mapping
// รัน:  cd tests && npm install && npm test
// ต้องมี Google Chrome หรือ Microsoft Edge ในเครื่อง (หรือกำหนด CHROME_PATH)
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(__dirname, ".cache");
const MOCK_JS = fs.readFileSync(path.join(__dirname, "mock-firebase.js"), "utf8");
const TZ = "Asia/Bangkok";
const ONLY = (process.env.ONLY || "").split(",").filter(Boolean);

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---------- static server ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204);
    return res.end();
  }
  const file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end("not found");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ---------- browser ----------
const chromePaths = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
].filter(Boolean);
const executablePath = chromePaths.find((p) => fs.existsSync(p));
const browser = await chromium.launch({ executablePath, headless: true });

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function newContext(mockCfg = {}) {
  const context = await browser.newContext({ timezoneId: TZ, locale: "th-TH", viewport: { width: 1400, height: 1000 } });
  await context.addInitScript((c) => {
    window.__MOCK_CFG = c;
  }, mockCfg);
  await context.route("https://www.gstatic.com/firebasejs/**", (route) => {
    const u = route.request().url();
    if (u.endsWith("firebase-app-compat.js")) return route.fulfill({ contentType: "text/javascript", body: MOCK_JS });
    return route.fulfill({ contentType: "text/javascript", body: "/* mock: database compat included in app */" });
  });
  await context.route(/tile\.openstreetmap\.org/, (route) => route.fulfill({ contentType: "image/png", body: PNG_1x1 }));
  await context.route("https://unpkg.com/**", async (route) => {
    const u = route.request().url();
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const f = path.join(CACHE_DIR, u.replace(/[^a-z0-9.@-]+/gi, "_"));
    if (fs.existsSync(f)) {
      const ct = u.endsWith(".css") ? "text/css" : "text/javascript";
      return route.fulfill({ contentType: ct, body: fs.readFileSync(f) });
    }
    const resp = await route.fetch();
    const body = await resp.body();
    if (resp.ok()) fs.writeFileSync(f, body);
    return route.fulfill({ response: resp, body });
  });
  return context;
}

async function openPage(context, page, file) {
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  await page.goto(`${BASE}/${file}`);
  return errors;
}

const VM = `(document.querySelector('#app')._vnode?.component?.proxy || document.querySelector('#app').__vue_app__?._instance?.proxy)`;

async function waitFor(page, fn, arg, { timeout = 20000, clock = false } = {}) {
  const start = Date.now();
  for (;;) {
    const ok = await (typeof fn === "function" ? page.evaluate(fn, arg) : page.evaluate(fn)).catch(() => false);
    if (ok) return true;
    if (Date.now() - start > timeout) return false;
    if (clock) await page.clock.runFor(250);
    else await page.waitForTimeout(100);
  }
}

function localDateKey(d) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  return f.format(d);
}
const DAY = 86400000;

async function stats(page) {
  return page.evaluate(() => {
    const s = window.__mock.stats;
    return {
      locationRecords: s.locationRecords,
      childAddedRecords: s.childAddedRecords,
      mappingRecords: s.mappingRecords,
      shallowCalls: s.shallowCalls,
      fullLocationsReads: s.fullLocationsReads,
      unboundedListeners: s.unboundedListeners,
      overlaps: s.overlaps.length,
      readCount: s.reads.filter((r) => r.path.startsWith("locations")).length,
      reads: s.reads.filter((r) => r.path.startsWith("locations")),
    };
  });
}

async function todayTotal(page, vids, from, to) {
  return page.evaluate(
    ({ vids, from, to }) => vids.reduce((sum, v) => sum + window.__mock.countRange(v, from, to), 0),
    { vids, from, to },
  );
}

const VIDS5 = ["veh-01", "veh-02", "veh-03", "veh-04", "veh-05"];
const VIDS4 = VIDS5.slice(0, 4);
const want = (name) => !ONLY.length || ONLY.includes(name);

// =====================================================================
// 0) static checks
// =====================================================================
if (want("static")) {
  const pageFiles = ["dashboard.js", "realtime.js", "history.js", "vehicle-mapping.js", "firebase-queries.js"];
  for (const f of fs.readdirSync(ROOT).filter((f) => f.endsWith(".js"))) {
    try {
      execFileSync(process.execPath, ["--check", path.join(ROOT, f)]);
      check(`node --check ${f}`, true);
    } catch (err) {
      check(`node --check ${f}`, false, err.message);
    }
  }
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  let fullReads = [];
  let unbounded = [];
  for (const f of pageFiles) {
    const code = stripComments(fs.readFileSync(path.join(ROOT, f), "utf8"));
    if (/ref\(\s*["'`]locations["'`]\s*\)/.test(code)) fullReads.push(f);
    const lines = code.split("\n");
    lines.forEach((line, i) => {
      if (/\.on\(\s*["']child_added["']/.test(line)) {
        const ctx = lines.slice(Math.max(0, i - 8), i + 1).join("\n");
        if (!/startAt\(/.test(ctx)) unbounded.push(`${f}:${i + 1}`);
      }
      if (/limitToLast\(/.test(line)) unbounded.push(`${f}:${i + 1} limitToLast`);
    });
  }
  check("grep: ไม่มี ref('locations') อ่านทั้งก้อน", !fullReads.length, fullReads.join(", "));
  check("grep: ไม่มี .on('child_added') ที่ไม่มี startAt / limitToLast", !unbounded.length, unbounded.join(", "));
  let untouched = true;
  try {
    execFileSync("git", ["-C", ROOT, "diff", "--quiet", "HEAD", "--", "app.js", "index.html"]);
  } catch {
    untouched = false;
  }
  check("app.js และ index.html ไม่ถูกแก้", untouched);
}

// =====================================================================
// 1) realtime: เปิดครั้งแรก / เปิดซ้ำด้วย cache / ตาราง + ตัวกรอง
// =====================================================================
if (want("realtime")) {
  const ctx = await newContext({ latencyMs: 20 });
  const page = await ctx.newPage();
  const errors = await openPage(ctx, page, "realtime.html");
  const loaded = await waitFor(page, () => window.__mock && window.__mock.listenerSummary().length === 5 && !(document.querySelector("#app")._vnode.component.proxy.loading));
  await page.waitForTimeout(1500);
  const today = localDateKey(new Date());
  const total = await todayTotal(page, VIDS5, today, today);
  const s = await stats(page);
  const vmInfo = await page.evaluate(`(() => { const vm = ${VM}; return { count: vm.visiblePointCount, rows: document.querySelectorAll('.table-card tbody tr').length, filteredCount: vm.filteredPointCount }; })()`);
  const listeners = await page.evaluate(() => window.__mock.listenerSummary());
  check("realtime: โหลดเสร็จ + ผูก listener ครบ 5 คัน", loaded);
  check("realtime: ไม่มีการอ่าน locations ทั้งก้อน", s.fullLocationsReads === 0, `fullReads=${s.fullLocationsReads}`);
  check("realtime: listener ทุกตัวมี startAt (ไม่ replay ประวัติ)", s.unboundedListeners === 0 && listeners.every((l) => l.start && l.start >= today), JSON.stringify(listeners.map((l) => l.start)));
  check(
    "realtime (เปิดครั้งแรก): record ≤ จุดวันนี้ + delta",
    s.locationRecords <= total + 5 * 3,
    `records=${s.locationRecords} จุดวันนี้=${total} (เดิม: ทุกจุด 60 วัน ≈ ${5 * 60 * 2880})`,
  );
  check("realtime: จำนวนจุดวันนี้บนหน้า = ข้อมูลจริง", vmInfo.count === total, `ui=${vmInfo.count} expected=${total}`);
  check("realtime: ตารางแสดง 200 แถวล่าสุด", vmInfo.rows === Math.min(200, total), `rows=${vmInfo.rows}`);

  // แสดงเพิ่ม
  await page.click("text=แสดงเพิ่ม");
  await page.waitForTimeout(200);
  const rows400 = await page.evaluate(() => document.querySelectorAll(".table-card tbody tr").length);
  check("realtime: ปุ่มแสดงเพิ่ม (+200 แถว)", rows400 === Math.min(400, total), `rows=${rows400}`);

  // ตัวกรอง: เทียบกับการกรองแบบเดิม (clone+sort ทุกจุด)
  const filterCheck = await page.evaluate(`(async () => {
    const vm = ${VM};
    const brute = (fv, slot) => {
      const rows = [];
      for (const v of vm.visibleVehicleSummaries) v.points.forEach((p) => rows.push({ ...p, vehicleId: v.vehicleId }));
      rows.sort((a, b) => (b.date - a.date) || a.vehicleId.localeCompare(b.vehicleId, 'th'));
      return rows.filter((p) => (!fv || p.vehicleId === fv) && (slot === '' || p.date.getHours() === Number(slot)));
    };
    const out = [];
    const cases = [['', ''], ['veh-02', ''], ['', String(new Date().getHours() === 0 ? 0 : new Date().getHours() - 1)], ['veh-03', String(new Date().getHours())]];
    for (const [fv, slot] of cases) {
      vm.filterVehicle = fv; vm.filterHourSlot = slot;
      await Vue.nextTick();
      const expected = brute(fv, slot);
      const got = vm.filteredPoints;
      const same = got.length === Math.min(vm.tableLimit, expected.length) && got.every((p, i) => p.key === expected[i].key && p.vehicleId === expected[i].vehicleId);
      out.push({ fv, slot, same, count: vm.filteredPointCount, expected: expected.length, limit: vm.tableLimit });
    }
    vm.filterVehicle = ''; vm.filterHourSlot = '';
    return out;
  })()`);
  check(
    "realtime: ตัวกรองรถ/ชั่วโมง ได้ผลเหมือนตรรกะเดิม + รีเซ็ตเป็น 200 แถว",
    filterCheck.every((c, i) => c.same && c.count === c.expected && (i === 0 || c.limit === 200)),
    JSON.stringify(filterCheck),
  );

  // เปิดซ้ำ: แสดง cache ทันที แล้วดึงเฉพาะส่วนต่าง
  await page.close(); // pagehide → flush cache ลง localStorage
  const page2 = await ctx.newPage();
  await page2.addInitScript(() => {
    window.__MOCK_CFG = Object.assign({}, window.__MOCK_CFG, { latencyMs: 1500 });
  });
  const errors2 = await openPage(ctx, page2, "realtime.html");
  // mapping ตอบที่ ~1.5 วิ (หน้าเดิมก็รอ mapping ก่อนแสดง cache) ส่วนจุดของวันนี้ตอบที่ ~3 วิ
  await page2.waitForTimeout(2300);
  const early = await page2.evaluate(`(() => { const vm = ${VM}; return { count: vm.visiblePointCount, reads: window.__mock.stats.reads.filter((r) => r.path.startsWith('locations')).length, mapped: window.__mock.stats.mappingRecords > 0, status: vm.status }; })()`);
  check("realtime (เปิดซ้ำ): แสดงข้อมูลจาก cache ทันทีก่อน Firebase ตอบ", early.count > 0 && early.reads === 0 && early.mapped, JSON.stringify(early));
  await waitFor(page2, () => window.__mock.listenerSummary().length === 5, null, { timeout: 15000 });
  await page2.waitForTimeout(2500);
  const s2 = await stats(page2);
  check("realtime (เปิดซ้ำ): ดึงเฉพาะส่วนต่างหลัง lastKey", s2.locationRecords <= 5 * 4, `records=${s2.locationRecords}`);
  const all = errors.concat(errors2);
  check("realtime: ไม่มี console error", !all.length, all.slice(0, 3).join(" | "));
  await ctx.close();
}

// =====================================================================
// 2) realtime: เวลา render ต่อจุดใหม่ ขณะมี ≥15,000 จุดในหน่วยความจำ
// =====================================================================
if (want("perf")) {
  const now = new Date();
  const midnight = new Date(`${localDateKey(now)}T00:00:00+07:00`);
  const secs = Math.floor((now - midnight) / 1000);
  const intervalSec = Math.max(1, Math.floor(secs / 3300)); // ≈3,300 จุด/คัน → ≥ 15,000 จุดรวม
  const ctx = await newContext({ intervalSec, days: 2, latencyMs: 5 });
  const page = await ctx.newPage();
  const errors = await openPage(ctx, page, "realtime.html");
  await waitFor(page, () => window.__mock.listenerSummary().length === 5, null, { timeout: 30000 });
  await page.waitForTimeout(2500);
  const perf = await page.evaluate(`(async () => {
    const vm = ${VM};
    const times = [];
    for (let i = 0; i < 15; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      const vid = 'veh-0' + ((i % 5) + 1);
      const before = vm.visiblePointCount;
      const t0 = performance.now();
      window.__mock.emitNow(vid);                         // child_added → merge
      const t1 = performance.now();
      vm.scheduleRenderRoute({ commit: true, immediate: true }); // บังคับ flush รอบนี้ทันที (ปกติรวมเป็น ≤1 ครั้ง/วิ)
      await new Promise((r) => setTimeout(r, 0));          // commit + render แผนที่ + patch DOM (microtask)
      await Vue.nextTick();
      const t2 = performance.now();
      times.push({ ms: t2 - t0, merge: t1 - t0, grew: vm.visiblePointCount === before + 1 });
    }
    const ms = times.map((t) => t.ms).sort((a, b) => a - b);
    return {
      points: vm.visiblePointCount,
      median: ms[Math.floor(ms.length / 2)],
      p90: ms[Math.floor(ms.length * 0.9)],
      max: ms[ms.length - 1],
      all: times.map((t) => Math.round(t.ms)).join(','),
      allGrew: times.every((t) => t.grew),
    };
  })()`);
  check("perf: มีจุดในหน่วยความจำ ≥ 15,000", perf.points >= 15000, `points=${perf.points} (interval ${intervalSec}s)`);
  check(
    "perf: render ต่อจุดใหม่ < 50 ms",
    perf.max < 50 && perf.allGrew,
    `median=${perf.median.toFixed(1)}ms p90=${perf.p90.toFixed(1)}ms max=${perf.max.toFixed(1)}ms [${perf.all}]`,
  );

  // การรวม update: emit ถี่ ๆ 20 จุดใน 1 วิ ต้อง commit ≤ 2 ครั้ง
  const batching = await page.evaluate(`(async () => {
    const vm = ${VM};
    let commits = 0;
    const stop = Vue.watch(() => vm.vehiclesById, () => { commits += 1; });
    for (let i = 0; i < 20; i += 1) { window.__mock.emitNow('veh-0' + ((i % 5) + 1)); await new Promise((r) => setTimeout(r, 50)); }
    await new Promise((r) => setTimeout(r, 1200));
    stop();
    return commits;
  })()`);
  check("perf: รวม update เป็น render ≤ 1 ครั้ง/วินาที", batching <= 3, `commits ใน ~2.2 วิ = ${batching}`);
  check("perf: ไม่มี console error", !errors.length, errors.slice(0, 3).join(" | "));
  await ctx.close();
}

// =====================================================================
// 3) realtime: เปิดทิ้ง 10 นาที / แท็บซ่อน / ตัดเน็ตแล้วต่อใหม่ (นาฬิกาจำลอง)
// =====================================================================
if (want("realtime-idle")) {
  const ctx = await newContext({ latencyMs: 20 });
  const page = await ctx.newPage();
  await page.clock.install({ time: new Date() });
  const errors = await openPage(ctx, page, "realtime.html");
  await waitFor(page, () => window.__mock.listenerSummary().length === 5, null, { clock: true });
  await page.clock.runFor(3000);
  const s0 = await stats(page);
  await page.clock.runFor(10 * 60 * 1000);
  const s1 = await stats(page);
  const resyncReads = s1.readCount - s0.readCount;
  check("realtime 10 นาที: ไม่มี request ซ้อนกัน", s1.overlaps === 0, `overlaps=${s1.overlaps}`);
  check("realtime 10 นาที: resync ทุก 45 วิ ดึงเฉพาะหลัง cursor", resyncReads <= 14 * 5 && s1.locationRecords - s0.locationRecords <= resyncReads + 5 * 25, `reads=${resyncReads} records=${s1.locationRecords - s0.locationRecords}`);

  // แท็บซ่อน: ไม่ resync + เขียน cache ลง localStorage ทันที
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const cacheWritten = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("farmchokchai_realtime_route_cache_v1")).length);
  const h0 = await stats(page);
  await page.clock.runFor(5 * 60 * 1000);
  const h1 = await stats(page);
  check("realtime แท็บซ่อน: ไม่ยิง resync", h1.readCount === h0.readCount, `reads +${h1.readCount - h0.readCount}`);
  check("realtime แท็บซ่อน: flush route cache ลง localStorage", cacheWritten === 5, `keys=${cacheWritten}`);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(3000);

  // ตัดเน็ต 3 นาที แล้วต่อใหม่ → ห้ามจุดตกหล่น
  await page.evaluate(() => window.__mock.setOnline(false));
  const o0 = await stats(page);
  await page.clock.runFor(3 * 60 * 1000);
  const o1 = await stats(page);
  await page.evaluate(() => window.__mock.setOnline(true));
  await page.clock.runFor(5000);
  const gap = await page.evaluate(`(() => {
    const vm = ${VM};
    const today = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); })();
    return window.__mock.VIDS.map((vid) => {
      const expected = window.__mock.keysInRange(vid, today, today);
      const got = new Set((vm.vehiclesById[vid]?.points || []).map((p) => p.key));
      const missing = expected.filter((k) => !got.has(k));
      return { vid, expected: expected.length, got: got.size, missing: missing.length };
    });
  })()`);
  check("realtime ออฟไลน์: ไม่ยิง resync ระหว่างออฟไลน์", o1.readCount === o0.readCount, `reads +${o1.readCount - o0.readCount}`);
  check("realtime ต่อเน็ตใหม่: ไม่มีจุดตกหล่น", gap.every((g) => g.missing === 0 && g.expected === g.got), JSON.stringify(gap));
  check("realtime idle: ไม่มี console error", !errors.length, errors.slice(0, 3).join(" | "));
  await ctx.close();
}

// =====================================================================
// 4) realtime: ข้ามเที่ยงคืน
// =====================================================================
if (want("midnight")) {
  const today = localDateKey(new Date());
  const tomorrow = localDateKey(new Date(Date.now() + DAY));
  const ctx = await newContext({ latencyMs: 20 });
  const page = await ctx.newPage();
  await page.clock.install({ time: new Date(`${today}T23:57:30+07:00`) });
  const errors = await openPage(ctx, page, "realtime.html");
  await waitFor(page, () => window.__mock.listenerSummary().length === 5, null, { clock: true });
  await page.clock.runFor(3000);
  const before = await page.evaluate(`(() => { const vm = ${VM}; return { day: vm.routeCacheDateKey, count: vm.visiblePointCount }; })()`);
  const s0 = await stats(page);
  await page.clock.runFor(4 * 60 * 1000); // ข้ามไป 00:01:30
  const after = await page.evaluate(`(() => {
    const vm = ${VM};
    const keys = Object.values(vm.vehiclesById).flatMap((v) => v.points.map((p) => p.key));
    return { day: vm.routeCacheDateKey, count: vm.visiblePointCount, allNewDay: keys.every((k) => k.startsWith('${tomorrow}')), listeners: window.__mock.listenerSummary().map((l) => l.start) };
  })()`);
  const s1 = await stats(page);
  const expectedNew = await todayTotal(page, VIDS5, tomorrow, tomorrow);
  check("เที่ยงคืน: เปลี่ยนเป็นวันใหม่และล้างจุดของเมื่อวาน", before.day === today && after.day === tomorrow && after.allNewDay, JSON.stringify({ before, after: { day: after.day, count: after.count, allNewDay: after.allNewDay } }));
  check("เที่ยงคืน: จุดของวันใหม่ครบ", after.count === expectedNew, `ui=${after.count} expected=${expectedNew}`);
  check("เที่ยงคืน: listener ใหม่เริ่มที่ต้นวันใหม่", after.listeners.length === 5 && after.listeners.every((k) => k >= tomorrow), JSON.stringify(after.listeners));
  check("เที่ยงคืน: ไม่ดึงข้อมูลย้อนหลังซ้ำ", s1.locationRecords - s0.locationRecords <= 5 * 30, `records=${s1.locationRecords - s0.locationRecords}`);
  check("เที่ยงคืน: ไม่มี console error", !errors.length, errors.slice(0, 3).join(" | "));
  await ctx.close();
}

// =====================================================================
// 5) history
// =====================================================================
if (want("history")) {
  const ctx = await newContext({ latencyMs: 20 });
  const page = await ctx.newPage();
  const dialogs = [];
  let dialogAnswer = true;
  page.on("dialog", async (d) => {
    dialogs.push(d.message());
    if (dialogAnswer) await d.accept();
    else await d.dismiss();
  });
  const errors = await openPage(ctx, page, "history.html");
  const vmLoaded = () => {
    const vm = document.querySelector("#app")._vnode.component.proxy;
    return !vm.loading && vm.trackSummaries.length === 4 && vm.trackSummaries.every((t) => t.status !== "ยังไม่ได้โหลด");
  };
  const loaded = await waitFor(page, vmLoaded);
  const today = localDateKey(new Date());
  const yesterday = localDateKey(new Date(Date.now() - DAY));
  const total4 = await todayTotal(page, VIDS4, today, today);
  let s = await stats(page);
  check("history: โหลดวันนี้ของ 4 คันอัตโนมัติ", loaded);
  check("history (วันนี้): record ≤ จุดวันนี้ของ 4 คัน", s.locationRecords <= total4 && s.fullLocationsReads === 0, `records=${s.locationRecords} expected≤${total4} (เดิม: ทุกจุดของทุกคัน ≈ ${5 * 60 * 2880 * 2})`);
  check("history: รายชื่อรถจาก shallow REST 1 ครั้ง", s.shallowCalls === 1, `shallow=${s.shallowCalls}`);
  const rows = await page.evaluate(() => document.querySelectorAll(".table-card tbody tr").length);
  check("history: ตารางแสดง 200 แถว", rows === 200, `rows=${rows}`);

  // เปลี่ยนวัน → ดึงแค่วันที่ยังไม่มีใน cache (เมื่อวาน) + จุดใหม่ของวันนี้ต่อจาก lastKey
  let base = s.locationRecords;
  await page.evaluate(`(${VM}).fromDate = '${yesterday}'`);
  await page.waitForTimeout(150);
  await page.evaluate(`(${VM}).fromDate = '${yesterday}'`);
  await waitFor(page, vmLoaded);
  await page.waitForTimeout(600);
  s = await stats(page);
  const total2d = await todayTotal(page, VIDS4, yesterday, today);
  const yTotal4 = await todayTotal(page, VIDS4, yesterday, yesterday);
  check(
    "history เปลี่ยนวัน: ดึงแค่วันที่ยังไม่มี (เมื่อวาน) + จุดใหม่ของวันนี้",
    s.locationRecords - base >= yTotal4 && s.locationRecords - base <= yTotal4 + 4 * 3,
    `records=${s.locationRecords - base} เมื่อวาน=${yTotal4} (ถ้าดึงทั้งช่วงใหม่ = ${total2d})`,
  );
  const shown = await page.evaluate(`(${VM}).visibleAllFilteredPoints.length`);
  check("history เปลี่ยนวัน: แสดงจุดครบช่วง", shown === total2d, `shown=${shown}`);

  // ลบจุดของเมื่อวาน (ใช้ตรวจว่า cache ใน IndexedDB ถูกอัปเดตด้วย ตอนเปิดหน้าใหม่ด้านล่าง)
  const delY = await page.evaluate(`(async () => {
    const vm = ${VM};
    const row = vm.visibleAllFilteredPoints.find((p) => p.key.startsWith('${yesterday}T12'));
    await vm.deletePoint(row);
    return { key: row.key, vid: row.vehicleId };
  })()`);

  // กลับไปวันนี้ → ใช้ cache ดึงแค่จุดใหม่ต่อจาก lastKey
  base = (await stats(page)).locationRecords;
  await page.evaluate(`(${VM}).fromDate = '${today}'`);
  await page.waitForTimeout(700);
  await waitFor(page, vmLoaded);
  s = await stats(page);
  check("history กลับไปช่วงเดิม: ไม่ดึงซ้ำ (เฉพาะจุดใหม่ของวันนี้)", s.locationRecords - base <= 4 * 3, `records +${s.locationRecords - base}`);

  // ปุ่มโหลด → bypass cache
  base = s.locationRecords;
  await page.click(".actions .btn.primary");
  await waitFor(page, vmLoaded);
  await page.waitForTimeout(300);
  s = await stats(page);
  const total4b = await todayTotal(page, VIDS4, today, today);
  check("history ปุ่มโหลด: บังคับดึงใหม่", s.locationRecords - base >= total4 && s.locationRecords - base <= total4b, `records=${s.locationRecords - base}`);

  // ลบจุด → ไม่โหลดใหม่ทั้งหมด
  base = s.locationRecords;
  const delInfo = await page.evaluate(`(() => { const vm = ${VM}; const r = vm.pagedRows[0]; return { key: r.key, vid: r.vehicleId, n: vm.visibleAllFilteredPoints.length, maxNo: Math.max(...vm.trackSummaries.find(t => t.vehicleId === r.vehicleId).filteredPoints.map(p => p.pointNo)) }; })()`);
  await page.click(".table-card tbody tr:first-child .row-btn.danger");
  await waitFor(page, `(() => !(${VM}).loading)()`);
  await page.waitForTimeout(300);
  s = await stats(page);
  const afterDel = await page.evaluate(`(() => { const vm = ${VM}; return { n: vm.visibleAllFilteredPoints.length, still: vm.visibleAllFilteredPoints.some(p => p.key === '${delInfo.key}' && p.vehicleId === '${delInfo.vid}'), deleted: window.__mock.deleted['${delInfo.vid}'].has('${delInfo.key}'), maxNo: Math.max(...vm.trackSummaries.find(t => t.vehicleId === '${delInfo.vid}').filteredPoints.map(p => p.pointNo)) }; })()`);
  check(
    "history ลบจุด: ลบใน Firebase + เอาออกจากหน้า โดยไม่โหลดใหม่",
    afterDel.deleted && !afterDel.still && afterDel.n === delInfo.n - 1 && s.locationRecords === base && afterDel.maxNo === delInfo.maxNo - 1,
    JSON.stringify({ before: delInfo.n, ...afterDel, records: s.locationRecords - base }),
  );

  // ขยายช่วงเป็น 4 วัน: ดึงแค่ 2 วันที่ยังไม่มี (2 × 4 คัน × 2,880 > 20,000 → confirm)
  base = s.locationRecords;
  const d3 = localDateKey(new Date(Date.now() - 3 * DAY));
  const d2x = localDateKey(new Date(Date.now() - 2 * DAY));
  await page.evaluate(`(${VM}).fromDate = '${d3}'`);
  await page.waitForTimeout(700);
  await waitFor(page, vmLoaded);
  s = await stats(page);
  const twoDays = await todayTotal(page, VIDS4, d3, d2x);
  check("history ขยายช่วง: confirm เมื่อคาดว่าเกิน 20,000 จุด", dialogs.some((m) => m.includes("ต้องดึงใหม่ 2 วัน")), dialogs.slice(-1)[0] || "");
  check(
    "history ขยายช่วง: ดึงเฉพาะวันที่ยังไม่มีใน cache",
    s.locationRecords - base >= twoDays && s.locationRecords - base <= twoDays + 4 * 3,
    `records=${s.locationRecords - base} วันที่ขาด=${twoDays}`,
  );

  // ช่วงเกิน 7 วัน → confirm; กดยกเลิก → ไม่ดึง
  base = s.locationRecords;
  dialogAnswer = false;
  const d9 = localDateKey(new Date(Date.now() - 9 * DAY));
  await page.evaluate(`(${VM}).fromDate = '${d9}'`);
  await page.waitForTimeout(800);
  s = await stats(page);
  const st = await page.evaluate(`(${VM}).status`);
  check("history ช่วง > 7 วัน: confirm และยกเลิกได้", dialogs.some((m) => m.includes("10 วัน")) && s.locationRecords === base && /ยกเลิก/.test(st), `status=${st}`);
  dialogAnswer = true;

  // marker thinning: 1 คัน 3 วัน (8,640 จุด) → marker ไม่เกิน ~5,000 แต่เส้นใช้จุดครบ
  await page.evaluate(`(() => { const vm = ${VM}; vm.vehicleId2 = ''; vm.vehicleId3 = ''; vm.vehicleId4 = ''; })()`);
  const d2 = localDateKey(new Date(Date.now() - 2 * DAY));
  await page.evaluate(`(${VM}).fromDate = '${d2}'`);
  await page.waitForTimeout(700);
  await waitFor(page, `(() => { const vm = ${VM}; return !vm.loading && vm.trackSummaries.length === 1 && vm.visibleAllFilteredPoints.length > 5000; })()`);
  const mapInfo = await page.evaluate(`(() => {
    const vm = ${VM};
    const t = vm.trackSummaries[0];
    const segPts = t.segments.reduce((s, g) => s + g.length, 0);
    const polyPts = routeLayers.reduce((s, l) => s + l.getLatLngs().length, 0);
    const preferCanvas = !!mapInstance.options.preferCanvas;
    pointLayers[1].fire('click');
    const popup = document.querySelector('.leaflet-popup-content')?.textContent || '';
    const boundPopups = pointLayers.filter((m) => m.getPopup && m.getPopup()).length;
    return { points: t.filteredPoints.length, segments: t.segments.length, markers: pointLayers.length, polyPts, segPts, preferCanvas, popup: popup.slice(0, 60), boundPopups };
  })()`);
  check("history แผนที่: preferCanvas + popup สร้างตอนคลิก", mapInfo.preferCanvas && mapInfo.popup.includes("คันที่ 1") && mapInfo.boundPopups === 0, JSON.stringify(mapInfo));
  check("history แผนที่: >5,000 จุด ลด marker แต่ polyline ใช้จุดครบ", mapInfo.markers <= 5000 + 2 * mapInfo.segments + 2 && mapInfo.polyPts === mapInfo.segPts, `markers=${mapInfo.markers} polyPts=${mapInfo.polyPts}/${mapInfo.segPts}`);

  // export CSV ยังทำงาน (ทุกแถว ไม่ใช่แค่ 200)
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("text=Export CSV >> nth=0")]);
  const csv = fs.readFileSync(await download.path(), "utf8");
  const csvRows = csv.trim().split("\n").length - 1;
  const allRows = await page.evaluate(`(${VM}).visibleAllFilteredPoints.length`);
  check("history: export CSV ครบทุกแถว", csvRows === allRows, `csv=${csvRows} rows=${allRows}`);

  // เปิดหน้าใหม่ (เหมือนปิดแล้วเข้าใหม่): วันในอดีตอ่านจาก IndexedDB ไม่ดาวน์โหลดซ้ำ
  const p2 = await ctx.newPage();
  p2.on("dialog", (d) => d.accept());
  const errors2 = await openPage(ctx, p2, "history.html");
  await waitFor(p2, vmLoaded);
  const r0 = await stats(p2);
  await p2.evaluate(`(${VM}).fromDate = '${d3}'`);
  await p2.waitForTimeout(700);
  await waitFor(p2, vmLoaded);
  const r1 = await stats(p2);
  const reopen = await p2.evaluate(`(() => {
    const vm = ${VM};
    return {
      // นับเฉพาะวันในอดีต (วันนี้มีจุดใหม่เข้าเรื่อย ๆ ระหว่างทดสอบ)
      shownPast: vm.visibleAllFilteredPoints.filter((p) => p.key < '${today}').length,
      deletedBack: vm.visibleAllFilteredPoints.some((p) => p.key === '${delY.key}' && p.vehicleId === '${delY.vid}'),
    };
  })()`);
  // mock เป็นฐานข้อมูลแยกต่อหน้า: หน้าใหม่ยังมีจุดของเมื่อวานที่ลบไปจากหน้าแรก จึงลบ 1 ออกจากค่าคาดหวัง
  const expectedPast = (await todayTotal(p2, VIDS4, d3, yesterday)) - 1;
  check(
    "history เปิดหน้าใหม่: วันในอดีตมาจาก cache ในเครื่อง (ไม่ดาวน์โหลด)",
    r1.locationRecords - r0.locationRecords <= 4 * 3 && reopen.shownPast === expectedPast,
    `records=${r1.locationRecords - r0.locationRecords} จุดวันในอดีตที่แสดง=${reopen.shownPast}/${expectedPast} (ถ้าไม่มี cache ต้องดึง ${expectedPast})`,
  );
  check("history เปิดหน้าใหม่: จุดที่ลบไปแล้วไม่กลับมาจาก cache", !reopen.deletedBack, JSON.stringify(delY));
  const all = errors.concat(errors2);
  check("history: ไม่มี console error", !all.length, all.slice(0, 3).join(" | "));
  await ctx.close();
}

// =====================================================================
// 6) dashboard
// =====================================================================
if (want("dashboard")) {
  const ctx = await newContext({ latencyMs: 20 });
  const page = await ctx.newPage();
  const errors = await openPage(ctx, page, "dashboard.html");
  const idle = `(() => { const vm = ${VM}; return !vm.loading && vm.lastUpdatedAt; })()`;
  await waitFor(page, idle);
  const today = localDateKey(new Date());
  const yesterday = localDateKey(new Date(Date.now() - DAY));
  const total5 = await todayTotal(page, VIDS5, today, today);
  let s = await stats(page);
  const ui = await page.evaluate(`(${VM}).totalPointCount`);
  check("dashboard (วันนี้): record ≤ จุดของวันนั้น", s.locationRecords <= total5 && s.fullLocationsReads === 0, `records=${s.locationRecords} expected≤${total5} (เดิม: ทุกจุด ≈ ${5 * 60 * 2880} ทุก 30 วิ)`);
  check("dashboard: จำนวนจุดบนหน้าตรงกับข้อมูล", ui === total5, `ui=${ui}`);

  // debounce + ทิ้งผลเก่า: เปลี่ยนวัน 3 ครั้งรวด → ดึงแค่วันสุดท้าย
  let base = s.locationRecords;
  const d2 = localDateKey(new Date(Date.now() - 2 * DAY));
  const d3 = localDateKey(new Date(Date.now() - 3 * DAY));
  await page.evaluate(`(async () => { const vm = ${VM}; vm.filterDate = '${d3}'; await new Promise(r => setTimeout(r, 100)); vm.filterDate = '${d2}'; await new Promise(r => setTimeout(r, 100)); vm.filterDate = '${yesterday}'; })()`);
  await page.waitForTimeout(600);
  await waitFor(page, idle);
  s = await stats(page);
  const yTotal = await todayTotal(page, VIDS5, yesterday, yesterday);
  check("dashboard: debounce 400ms ดึงแค่ค่าสุดท้าย", s.locationRecords - base === yTotal, `records=${s.locationRecords - base} expected=${yTotal}`);

  // วันในอดีต: cache ไม่ดึงซ้ำ
  await page.evaluate(`(${VM}).filterDate = '${today}'`);
  await page.waitForTimeout(600);
  await waitFor(page, idle);
  const sToday = await stats(page);
  check("dashboard กลับมาวันนี้: ดึงต่อจาก lastKey (incremental)", sToday.locationRecords - s.locationRecords <= 5 * 3, `records=${sToday.locationRecords - s.locationRecords}`);
  await page.evaluate(`(${VM}).filterDate = '${yesterday}'`);
  await page.waitForTimeout(600);
  await waitFor(page, idle);
  s = await stats(page);
  check("dashboard วันในอดีต: ใช้ cache ไม่ดึงซ้ำ", s.locationRecords === sToday.locationRecords, `records +${s.locationRecords - sToday.locationRecords}`);

  // เดือน: ดึงเฉพาะเดือนที่เลือก
  base = s.locationRecords;
  const month = today.slice(0, 7);
  await page.evaluate(`(() => { const vm = ${VM}; vm.filterMode = 'month'; vm.filterMonth = '${month}'; })()`);
  await page.waitForTimeout(600);
  await waitFor(page, idle, null, { timeout: 30000 });
  s = await stats(page);
  const monthTotal = await todayTotal(page, VIDS5, month, month);
  check("dashboard (เดือน): ดึงเฉพาะเดือนที่เลือก", s.locationRecords - base <= monthTotal, `records=${s.locationRecords - base} expected≤${monthTotal}`);
  check("dashboard: ไม่มี console error", !errors.length, errors.slice(0, 3).join(" | "));
  await ctx.close();

  // เปิดทิ้ง 10 นาที (นาฬิกาจำลอง)
  const ctx2 = await newContext({ latencyMs: 20 });
  const p2 = await ctx2.newPage();
  await p2.clock.install({ time: new Date() });
  const errors2 = await openPage(ctx2, p2, "dashboard.html");
  await waitFor(p2, idle, null, { clock: true });
  const a0 = await stats(p2);
  await p2.clock.runFor(10 * 60 * 1000);
  const a1 = await stats(p2);
  const reads = a1.readCount - a0.readCount;
  check("dashboard 10 นาที: ไม่มี request ซ้อนกัน", a1.overlaps === 0, `overlaps=${a1.overlaps}`);
  check("dashboard 10 นาที: auto refresh ทุก ≥60 วิ แบบ incremental", reads <= 10 * 5 && a1.locationRecords - a0.locationRecords <= reads + 5 * 25, `reads=${reads} records=${a1.locationRecords - a0.locationRecords}`);
  await p2.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const h0 = await stats(p2);
  await p2.clock.runFor(5 * 60 * 1000);
  const h1 = await stats(p2);
  check("dashboard แท็บซ่อน: ไม่ refresh", h1.readCount === h0.readCount, `reads +${h1.readCount - h0.readCount}`);
  check("dashboard idle: ไม่มี console error", !errors2.length, errors2.slice(0, 3).join(" | "));
  await ctx2.close();
}

// =====================================================================
// 7) vehicle-mapping + shallow ล้มเหลว
// =====================================================================
if (want("mapping")) {
  const ctx = await newContext({ latencyMs: 20 });
  const page = await ctx.newPage();
  const errors = await openPage(ctx, page, "vehicle-mapping.html");
  await waitFor(page, `(() => { const vm = ${VM}; return !vm.loading && vm.deviceOptions.length === 5; })()`);
  const s = await stats(page);
  check("vehicle-mapping: ได้รายชื่อรถโดยไม่ดึงจุด GPS", s.locationRecords === 0 && s.shallowCalls === 1, `records=${s.locationRecords} shallow=${s.shallowCalls}`);
  // ไปหน้า history ในแท็บเดียวกัน (sessionStorage เป็นของแต่ละแท็บ) → ใช้ cache รายชื่อรถ
  const p2 = page;
  await p2.goto(`${BASE}/history.html`);
  await waitFor(p2, `(() => (${VM}).deviceOptions.length === 5)()`);
  const s2 = await stats(p2);
  check("listVehicleIds: cache ใน sessionStorage (ไม่ยิง shallow ซ้ำ)", s2.shallowCalls === 0, `shallow=${s2.shallowCalls}`);
  check("vehicle-mapping: ไม่มี console error", !errors.length, errors.slice(0, 3).join(" | "));
  await ctx.close();

  const ctx3 = await newContext({ latencyMs: 20, shallowFail: true });
  const p3 = await ctx3.newPage();
  await openPage(ctx3, p3, "vehicle-mapping.html");
  await waitFor(p3, `(() => !(${VM}).loading)()`);
  const st = await p3.evaluate(`(() => { const vm = ${VM}; return { status: vm.status, type: vm.statusType }; })()`);
  const s3 = await stats(p3);
  check("shallow ล้มเหลว: แสดง error และไม่ fallback อ่าน locations ทั้งก้อน", st.type === "error" && s3.fullLocationsReads === 0 && s3.locationRecords === 0, JSON.stringify(st));
  await ctx3.close();
}

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(__dirname, "results.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
