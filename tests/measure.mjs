// วัดจำนวน read / record ที่แต่ละหน้าดึงตอนเปิด (ใช้เทียบ ก่อน/หลัง)
// ใช้: node measure.mjs [rootDir]   (ค่าเริ่มต้น = โฟลเดอร์โปรเจกต์)
import { chromium } from "playwright-core";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const MOCK = fs.readFileSync(path.join(__dirname, "mock-firebase.js"), "utf8");
const CACHE = path.join(__dirname, ".cache");
const srv = http.createServer((q, r) => {
  const f = path.join(ROOT, decodeURIComponent(new URL(q.url, "http://x").pathname));
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(f.endsWith("favicon.ico") ? 204 : 404); return r.end(); }
  r.writeHead(200, { "Content-Type": f.endsWith(".js") ? "text/javascript" : f.endsWith(".css") ? "text/css" : "text/html; charset=utf-8" });
  fs.createReadStream(f).pipe(r);
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${srv.address().port}`;
const exe = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", process.env.CHROME_PATH].find((p) => p && fs.existsSync(p));
const browser = await chromium.launch({ executablePath: exe });
const out = {};
for (const [page, waitMs] of [["realtime.html", 60000], ["history.html", 60000], ["dashboard.html", 60000], ["vehicle-mapping.html", 15000]]) {
  const ctx = await browser.newContext({ timezoneId: "Asia/Bangkok" });
  await ctx.addInitScript(() => { window.__MOCK_CFG = { latencyMs: 20 }; });
  await ctx.route("https://www.gstatic.com/firebasejs/**", (r) => r.fulfill({ contentType: "text/javascript", body: r.request().url().endsWith("app-compat.js") ? MOCK : "" }));
  await ctx.route(/tile\.openstreetmap/, (r) => r.fulfill({ status: 204 }));
  await ctx.route("https://unpkg.com/**", async (r) => {
    const u = r.request().url(); const f = path.join(CACHE, u.replace(/[^a-z0-9.@-]+/gi, "_"));
    if (fs.existsSync(f)) return r.fulfill({ contentType: u.endsWith(".css") ? "text/css" : "text/javascript", body: fs.readFileSync(f) });
    const resp = await r.fetch(); const body = await resp.body(); if (resp.ok()) { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(f, body); }
    return r.fulfill({ response: resp, body });
  });
  const p = await ctx.newPage();
  const t0 = Date.now();
  await p.goto(`${BASE}/${page}`);
  // รอจนหน้าโหลดเสร็จ (ไม่มี read ใหม่ 3 วิ) หรือครบเวลา
  let last = -1, stable = 0;
  while (Date.now() - t0 < waitMs) {
    await p.waitForTimeout(1000);
    const n = await p.evaluate(() => window.__mock.stats.locationRecords + window.__mock.stats.reads.length).catch(() => last);
    stable = n === last ? stable + 1 : 0; last = n;
    if (stable >= 3) break;
  }
  const s = await p.evaluate(() => { const s = window.__mock.stats; return { onceReads: s.reads.length, locationReads: s.reads.filter((r) => r.path.startsWith("locations")).length, locationRecords: s.locationRecords, childAddedRecords: s.childAddedRecords, mappingRecords: s.mappingRecords, shallowCalls: s.shallowCalls, fullLocationsReads: s.fullLocationsReads, unboundedListeners: s.unboundedListeners }; }).catch((e) => ({ error: String(e) }));
  s.seconds = Math.round((Date.now() - t0) / 1000);
  out[page] = s;
  console.log(page, JSON.stringify(s));
  await ctx.close();
}
await browser.close(); srv.close();
