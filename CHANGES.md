# CHANGES — ลดการดาวน์โหลดจาก Firebase RTDB + ทำให้หน้า realtime / history ลื่น

ฐาน: `62acbd9` (branch `FIX-performance`)  
ขอบเขต: ไม่เปลี่ยน schema / path / ชื่อ field, ไม่สร้าง node ใหม่, ไม่แตะ `app.js` และ `index.html`

## สรุปผล (วัดจริงด้วย mock Firebase: 5 คัน × 60 วัน × 2,880 จุด/วัน, เปิดหน้าเวลา ~11:15 น.)

"record" = จำนวนจุด GPS (`locations/{id}/{key}`) ที่ Firebase ส่งกลับมาให้หน้าเว็บ
(1 record ≈ 150 byte JSON → 860,000 record ≈ 130 MB ต่อการเปิดหน้า 1 ครั้ง)

| หน้า / เหตุการณ์ | ก่อน (read / record) | หลัง (read / record) |
|---|---|---|
| **realtime** เปิดครั้งแรก | 5 once + 5 `child_added` ไม่มี query → **863,130** (replay ประวัติทุกคันทั้ง 60 วัน) | 5 once + 5 listener จาก cursor → **6,775** (= จุดวันนี้ 6,770 + cursor 5) |
| realtime เปิดซ้ำ (มี cache ใน localStorage) | replay ทั้งประวัติอีกรอบ ≈ 860,000 | **10** (ส่วนต่างหลัง lastKey) |
| realtime เปิดทิ้ง 10 นาที | resync 45 วิ (ไม่มี guard / ไม่สนแท็บซ่อน) | 65 read / 165 record, ไม่มี request ซ้อน, แท็บซ่อน/ออฟไลน์ = 0 |
| **history** เปิด (วันนี้ 4 คัน) | 1 read `locations` ทั้งก้อน + 4 read ทั้งประวัติรายคัน → **1,541,466** | shallow REST 1 ครั้ง (ได้แค่ชื่อรถ) + 4 read ช่วงวันนี้ → **5,420** |
| history เปลี่ยนวัน | 0 (เพราะโหลดทั้งประวัติไว้แล้ว) | ดึงเฉพาะ [from, to] เช่น 2 วัน 4 คัน = 16,924 / กลับช่วงเดิม = 0 (cache) |
| history ลบจุด 1 จุด | โหลดทั้งประวัติ 4 คันใหม่ ≈ 690,000 | **0** (เอาออกจาก state ในเครื่อง) |
| **dashboard** เปิด (โหมดวัน = วันนี้) | 1 read `locations` ทั้งก้อน → **856,370** | shallow 1 + 5 read ช่วงวันนี้ → **6,775** |
| dashboard เปิดทิ้ง 10 นาที | ดึงทั้งก้อนทุก 30 วิ = 20 × 856,370 ≈ **17 ล้าน** | 50 read / **150** (incremental ทุก 60 วิ เฉพาะโหมดวันนี้ + แท็บที่มองเห็น) |
| dashboard วัน/เดือน/ปี ในอดีต | ดึงทั้งก้อนแล้วกรองในเครื่อง | ดึงเฉพาะช่วง ครั้งเดียว แล้ว cache ในหน่วยความจำ (เลือกซ้ำ = 0) |
| **vehicle-mapping** เปิด | 1 read `locations` ทั้งก้อน → **856,370** | shallow REST 1 ครั้ง → **0** record (5 key) |

ความเร็ว (Playwright, Chrome, 16,890 จุดในหน่วยความจำ): เวลาตั้งแต่ได้จุดใหม่ → merge → commit → วาดแผนที่ → patch DOM
**median ≈ 21 ms, p90 ≈ 24 ms, max ≈ 42 ms** (เกณฑ์ < 50 ms)

ผลทดสอบทั้งหมด: `tests/run-tests.mjs` → **69/69 ผ่าน** (ดู `tests/results.json`)

## ไฟล์ที่เพิ่ม

- `firebase-queries.js` — จุดเดียวที่อ่าน `locations`
  - `listVehicleIds(db, {mappings, force, skipLocations})`: vehicle_mappings ∪ `GET {databaseURL}/locations.json?shallow=true`
    (ได้แค่ชื่อ key), cache ใน sessionStorage 10 นาที, **ไม่มี fallback** ไปอ่าน `ref('locations')` เต็ม ถ้าพลาดคืน `shallowError` ให้หน้าแสดง error
  - `fetchRange(db, id, from, to)`: `orderByKey().startAt(from).endAt(to + "").once('value')`
  - `fetchAfter(db, id, cursor, to?)`: `orderByKey().startAt(cursor)[.endAt(...)]` (ผู้เรียกข้าม key == cursor)
  - `listenAfter(db, id, startKey, cb, err)`: `child_added` บน `orderByKey().startAt(startKey)` เสมอ + ข้าม key == startKey
- `tests/` — mock Firebase แบบ virtual + Playwright (`npm test`) + `measure.mjs` (วัด ก่อน/หลัง)
- `.gitignore` — ไม่เก็บ `tests/node_modules`, `tests/.cache`, ไฟล์ zip

## การเปลี่ยนแปลงรายหน้า

### dashboard.js / dashboard.html
- ดึงรายคันตามช่วง prefix (`YYYY-MM-DD` / `YYYY-MM` / `YYYY`) ด้วย `fetchRange` แทนการอ่าน `locations` ทั้งก้อน
- ช่วงในอดีตที่ดึงครบแล้ว cache ในหน่วยความจำ (สูงสุด 6 ช่วง) ไม่ refresh อีก; ช่วงที่ยังเปิด (มีวันนี้) เลือกซ้ำ = ดึงต่อจาก lastKey
- auto refresh: **ทุก 60 วิ เฉพาะโหมด "วัน" ที่เป็นวันนี้ + แท็บมองเห็น** + in-flight guard (เดิมทุก 30 วิ ทุกโหมด)
- เปลี่ยนตัวกรอง → debounce 400 ms และทิ้งผลของ request เก่าด้วยเลขลำดับ
- ปุ่ม "รีเฟรชข้อมูล" (`refreshAll({ force: true })`) ดึงช่วงที่เลือกใหม่ทั้งหมด
- จุดของแต่ละคันเป็น `markRaw` (ไม่ deep reactive); ตรรกะกรองวัน/เดือน/ปี และ `isSuspiciousJump` เหมือนเดิม

### realtime.js / realtime.html
- `child_added` ใช้ `orderByKey().startAt(vehicleLastKey[id] || ต้นวันนี้)` เสมอ ข้าม key == cursor (แก้ regression จาก 62acbd9 ที่ replay ทั้งประวัติ)
- `loadTrackedVehicleIds` ใช้ `listVehicleIds` (ลำดับเดิม: ใช้ mapping ก่อน ถ้าไม่มีค่อยใช้ชื่อ node ใน locations ผ่าน shallow)
- resync 45 วิ + visibilitychange คงไว้ แต่ข้ามเมื่อแท็บซ่อน / ออฟไลน์ / รอบก่อนยังไม่เสร็จ; ไม่มี cursor → เริ่มต้นวันนี้ (เลิกใช้ `limitToLast(200)`)
- อัปเดต `vehiclesById` เฉพาะเมื่อมีจุดใหม่จริง และรวม commit + render แผนที่ **≤ 1 ครั้ง/วินาที**
- merge จุด: กันซ้ำด้วย `Set` ของ key (O(1)), จุดที่ต่อท้ายไม่ต้อง normalize/sort ทั้งชุด, array ของจุดเป็น `markRaw`, เลิกเก็บ `raw`
- ตาราง: แสดง 200 แถวล่าสุดหลังกรอง + ปุ่ม "แสดงเพิ่ม" (ทีละ 200), merge จากท้าย array ของแต่ละคันแทน clone+sort ทุกจุด, `v-memo` ต่อแถว; ตัวกรองรถ/ชั่วโมงให้ผลเหมือนเดิม (ทดสอบเทียบกับตรรกะเดิม)
- `writeRouteCache` หน่วงเป็น ≤ 1 ครั้ง/10 วิ + flush ตอน `pagehide` / แท็บถูกซ่อน / ก่อน subscribe ใหม่
- ข้ามเที่ยงคืน: ตรวจทุก 30 วิ และทุกครั้งที่มีจุดเข้า → subscribe ใหม่จากต้นวันใหม่ (ล้างจุดของเมื่อวาน)
- segments/ระยะทางต่อคัน memo ตาม array (คำนวณใหม่เฉพาะคันที่มีจุดใหม่)
- แผนที่:
  - **แก้:** group ของรถถูกเพิ่มลงแผนที่ตั้งแต่สร้าง (เดิมถูกเพิ่มใน render รอบที่ 2 ซึ่งเคยเกิดจากการ replay ทั้งประวัติ ถ้าไม่แก้ รถที่ยังไม่มีจุดใหม่จะไม่ถูกวาด)
  - **แก้:** การวาดใหม่ทั้งชุด (เมื่อจุดมาไม่เรียงเวลา) สร้าง polyline ทีเดียวต่อช่วง แทน `addLatLng` ทีละจุด ซึ่งเป็น O(n²) (วัดได้ ~5 วินาทีที่ 3,300 จุด)
  - เส้นทางแบ่งเป็นท่อนละ ≤ 250 จุด (ภาพเหมือนเดิม) และ marker จุดล่าสุดอัปเดตแทนการลบ/สร้างใหม่ → canvas วาดใหม่แค่บริเวณที่เปลี่ยน
- `fitToRoute` / ปุ่ม "จัดขอบแผนที่" ใช้ `visiblePointCount` แทน `visiblePoints` (ไม่ clone ทุกจุด)

### history.js / history.html
- รายชื่อ device ใช้ `listVehicleIds` (ชื่อ node ใน locations ผ่าน shallow) แทนการอ่าน `locations` ทั้งก้อน
- `loadTracks` ดึงเฉพาะ [fromDate, toDate] ของรถที่เลือก; cache ในหน่วยความจำ key = `vehicleId|from|to` (ช่วงที่รวมวันนี้ใช้ cache ได้ 60 วิ), เลขลำดับ request กันผลเก่าทับ
- เปลี่ยน fromDate/toDate → debounce 400 ms แล้วดึงใหม่; เลือก device → ใช้ cache ของคันที่ไม่เปลี่ยน
- ช่วง > 7 วัน หรือคาดว่า > 20,000 จุด → `confirm` ก่อนโหลด (ประมาณจาก 2,880 จุด/คัน/วัน ปรับได้ที่ `window.FCGPS_POINTS_PER_DAY`)
- ปุ่ม "โหลดข้อมูล" (`reloadTracks`) บังคับ bypass cache
- ลบจุด: ลบใน Firebase แล้วเอาออกจาก state + cache ในเครื่อง คำนวณเลขจุด/ระยะสะสมใหม่ ไม่ reload
- ตาราง 200 แถว + "แสดงเพิ่ม"; Export CSV ยังส่งออกครบทุกแถว
- แผนที่ `preferCanvas: true`, popup สร้างตอนคลิก (ข้อความเดิม), ถ้าเกิน 5,000 จุด/คัน แสดง marker ต้น/ปลายแต่ละช่วง + ทุก k จุด แต่ polyline ใช้จุดครบ
- จุดเป็น `markRaw`, เลิกเก็บ `raw`

#### history รอบที่ 2: cache รายวัน (`history-day-cache.js`)
- cache เปลี่ยนจาก "ต่อช่วงวันที่" เป็น **รายคัน × รายวัน**
- วันที่ปิดแล้ว (ดึงหลังเที่ยงคืนของวันถัดไป ≥ 1 ชม.) เก็บลง **IndexedDB** ของเบราว์เซอร์ → เปิดหน้าใหม่/วันหลัง ไม่ดาวน์โหลดซ้ำ (สูงสุด 240 คัน×วัน)
- เปลี่ยน/ขยายช่วงวันที่ → ดึงเฉพาะวันที่ยังไม่มี (วันที่ติดกันรวมเป็น query เดียว); วันในอนาคตไม่ query
- วันนี้ → ดึงต่อจาก lastKey (เฉพาะจุดใหม่) แทนดึงทั้งวันใหม่
- confirm ช่วงยาว นับเฉพาะวันที่ต้องดึงจริง ("ช่วงที่เลือก X วัน ต้องดึงใหม่ Y วัน ...")
- ลบจุด → ลบออกจาก cache รายวัน (รวม IndexedDB) ด้วย; ปุ่ม "โหลดข้อมูล" ยังบังคับดึงใหม่ทั้งช่วงและเขียนทับ cache
- ผล (mock): 7 วัน 4 คัน ครั้งแรก 69,124 record → เปิดหน้าใหม่ 4 record (257 ms จาก IndexedDB)
- ข้อจำกัด: ถ้ามีคนลบจุดจากเครื่องอื่น วันในอดีตที่ cache ไว้จะยังเห็นจุดนั้นจนกด "โหลดข้อมูล";
  จุดของวันนี้ที่อัปโหลดย้อนหลัง (key เก่ากว่า lastKey) จะเห็นเมื่อกด "โหลดข้อมูล"

### vehicle-mapping.js / vehicle-mapping.html
- รายชื่อ device ใช้ `listVehicleIds` (shallow) ; ปุ่ม "รีเฟรช" (`reloadAll(true)`) ข้าม cache รายชื่อรถ

### ทุกหน้า (dashboard / realtime / history / vehicle-mapping)
- pin `vue@3.4.38/dist/vue.global.prod.js` (เดิม `vue@3` dev build ไม่ pin เวอร์ชัน)
- โหลด `firebase-queries.js` หลัง `firebase-config.js`

## พฤติกรรมที่ผู้ใช้อาจสังเกตเห็นต่างจากเดิม

1. dashboard: เดือน/ปี/วันในอดีต ไม่ auto refresh แล้ว (ข้อมูลอดีตไม่เปลี่ยน) ; โหมดวันนี้ refresh ทุก 60 วิ แทน 30 วิ ; แท็บที่ซ่อนไม่ refresh
2. realtime: จุดใหม่อาจขึ้นช้าสุด ~1 วิ (รวม render) ; ตารางแสดง 200 แถวแรก + ปุ่ม "แสดงเพิ่ม"
3. history: เปลี่ยนวันแล้วดึงข้อมูลใหม่ (มี confirm ถ้าช่วงยาว) ; "อัปเดตล่าสุด" ของข้อมูลจาก cache = เวลาที่ดึงจริง ; popup ของจุดสร้างตอนคลิก ; ถ้าเกิน 5,000 จุด/คัน จุดกลางทางบางจุดไม่มี marker (เส้นยังครบ)
4. รายชื่อรถ cache 10 นาทีต่อแท็บ: รถใหม่จะเห็นใน history/dashboard ภายใน 10 นาที หรือกด "รีเฟรช" ในหน้าตั้งค่ารถ (มีผลกับแท็บนั้น)
5. ใช้ Vue production build: ไม่มี warning ของ Vue ใน console

## สิ่งที่ยืนยันไม่ได้ (ไม่ได้ทดสอบกับ Firebase จริง)

- ไม่ได้รันกับฐานข้อมูลจริง ตัวเลขทั้งหมดมาจาก mock ที่จำลอง API ของ compat SDK (`once`, `on('child_added')`, `orderByKey/startAt/endAt`) และ REST shallow
- shallow REST ใช้สิทธิ์อ่านเดียวกับ SDK: ถ้า rules ของ `/locations` ต้องใช้ auth (ปัจจุบันหน้าเว็บไม่มี firebase-auth) shallow จะได้ 401 และหน้าจะแสดง error ตามที่กำหนด
- การ re-sync ของ `child_added` หลังเน็ตหลุดเป็นพฤติกรรมของ SDK จริง; ใน mock จำลองให้ส่งจุดที่พลาดเมื่อกลับมาออนไลน์ และมี resync 45 วิ เป็นตัวสำรอง
- ช่วงวันใช้ prefix ของ key (`YYYY-MM-DD` ตามเวลาของเครื่องที่เปิดหน้า) — ถูกต้องเมื่อเครื่องส่ง (+07:00) และเครื่องดูอยู่ timezone เดียวกัน
- จุดที่อุปกรณ์อัปโหลดย้อนหลัง (key เก่ากว่า cursor) หลังจากกด "รีเฟรชข้อมูลสด" จะไม่ถูกดึง (พฤติกรรมเดียวกับ cursor เดิม; listener ที่ผูกไว้ก่อนหน้ายังรับได้)
- ทดสอบเฉพาะ Chrome desktop; ยังไม่ทดสอบ Safari / มือถือ
- README บอกว่าอุปกรณ์ส่งทุก 5 วิ (= 17,280 จุด/คัน/วัน) แต่ค่าประมาณสำหรับ confirm ใช้ 2,880 ตามโจทย์ — ถ้าส่งทุก 5 วิจริง ควรตั้ง `window.FCGPS_POINTS_PER_DAY = 17280`
- dashboard โหมด "ปี" ยังต้องดึงทั้งปีของทุกคัน (≈ 5 ล้าน record ที่ 30 วิ/จุด) — ลดได้จริงต้องใช้ข้อเสนอข้อ 1 ด้านล่าง

## บั๊กเดิมที่พบระหว่างทำ (ยังไม่แก้ เพราะอยู่นอกขอบเขต / เปลี่ยนสิ่งที่ผู้ใช้เห็น)

1. realtime: `detachLiveListener()` ถอด listener `.info/connected` ของหน้าเองทุกครั้งที่ subscribe → badge ค้าง "กำลังตรวจสอบ Firebase..." และแจ้งเตือน "Firebase หลุดการเชื่อมต่อ" ไม่ทำงาน (ยืนยันกับ HEAD เดิมแล้ว) — ตอนนี้ใช้ listener แยก (`rtdbConnected`) สำหรับข้าม resync ตอนออฟไลน์เท่านั้น ไม่แตะการแสดงผล
2. history Export CSV: หัวตาราง 10 คอลัมน์ แต่ข้อมูล 11 ค่า (speed ซ้ำ 2 ช่อง) ทำให้คอลัมน์หลัง Speed เลื่อน
3. realtime: checkbox ตัวกรองรถขึ้นเป็น "ไม่ติ๊ก" ตอนเริ่ม ทั้งที่รถแสดงอยู่ และการติ๊กไม่ redraw แผนที่จนกว่าจะมีจุดใหม่

## ข้อเสนอเพิ่มเติม (ยังไม่ทำ — รออนุมัติ)

1. node เสริม `daily_summary/{vehicleId}/{YYYY-MM-DD}` = {pointCount, distanceKm, first, last} ให้ dashboard เดือน/ปี อ่านแค่ 30–365 record ต่อคัน (ต้องมีตัวเขียน: Cloud Function หรือ job รายวัน — ไม่แตะ `app.js`)
2. node `latest/{vehicleId}` = จุดล่าสุด ให้หน้า realtime/แจ้งเตือน stale เช็กได้โดยไม่ต้องโหลดทั้งวัน
3. แก้บั๊กข้อ 1–3 ด้านบน
4. ตั้ง Firebase budget alert / ตรวจ Usage tab หลัง deploy เพื่อยืนยันตัวเลขจริง
5. ตรวจ Firebase rules ของ `/locations` (หน้าเว็บไม่มีระบบล็อกอิน แต่ลบจุดได้จาก history ถ้า rules เปิดให้เขียนได้ทุกคน ใครมี URL ก็ลบได้)

## วิธีทดสอบซ้ำ

```bash
cd tests
npm install
npm test                 # 69 checks: grep, จำนวน record, cache, debounce, ลบจุด, ออฟไลน์, เที่ยงคืน, perf
node measure.mjs         # วัด read/record ตอนเปิดแต่ละหน้า
node measure.mjs <dir>   # วัดโฟลเดอร์อื่น (เช่น git archive ของเวอร์ชันเก่า) เพื่อเทียบ
```
