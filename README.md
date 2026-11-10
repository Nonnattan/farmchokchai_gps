# GPS Tracker Starter v3

โปรเจกต์ตัวอย่างสำหรับ
- อ่าน GPS จาก browser ด้วย `navigator.geolocation.watchPosition()`
- เก็บ `lat`, `lng`, `speed`, `timestamp`
- บันทึกลง Firebase Realtime Database

## จุดสำคัญ
- ใช้งานได้บน `HTTPS` หรือ `localhost`
- `speed` อาจเป็น `null` ได้
- ถ้า accuracy ยังไม่ดีพอ ระบบจะรอและยังไม่เขียนลงฐานข้อมูล
- ไฟล์นี้ใช้ **Realtime Database** ไม่ได้ใช้ Firestore

## ถ้ายังไม่บันทึก
1. เปิด DevTools ดูว่า `firebaseConfig` ใส่ค่าจริงครบหรือยัง
2. ตรวจ Firebase Realtime Database Rules ว่าอนุญาตเขียนหรือไม่
3. ตรวจว่าไม่มี extension หรือ adblock บล็อก request ไปยัง `firebaseio.com` / `googleapis.com`

## ตั้งค่า Firebase แบบสั้น
1. สร้าง Firebase Project
2. เปิด Realtime Database
3. คัดลอก config จาก Project settings
4. วางใน `firebase-config.js`
5. Deploy ผ่าน Firebase Hosting หรือรันบน `localhost`

## โครงสร้างข้อมูล
```
locations/
  demo-user/
    -Nxxxxxx
      lat
      lng
      speed
      timestamp
      browserTimestampMs
      accuracy
```
# Farm Chokchai GPS - Realtime No Data Alert

โฟลเดอร์นี้เป็นชุดไฟล์ที่ปรับจากโปรเจกต์เดิม โดยเพิ่มการแจ้งเตือนเมื่อ "วันนี้ยังไม่มีข้อมูล GPS" ในหน้า Realtime

## ที่เพิ่มให้
- แสดงแถบแจ้งเตือนสีส้มเมื่อวันนี้ยังไม่มีข้อมูล
- ปุ่มเปิดแจ้งเตือนบนเบราว์เซอร์
- ปุ่มตรวจข้อมูลใหม่อีกครั้ง

## วิธีใช้
1. เปิด `realtime.html`
2. ถ้าวันนี้ไม่มีข้อมูล ระบบจะแสดงแถบแจ้งเตือนทันที
3. ถ้าอนุญาต Notification แล้ว เบราว์เซอร์จะแจ้งเตือนด้วย

## หมายเหตุ
ถ้าต้องการแจ้งเตือนแม้ปิดหน้าเว็บ ต้องใช้ Firebase Cloud Messaging หรือระบบ backend เพิ่มเติม


## การแยกสาเหตุแจ้งเตือน

- `Firebase มีปัญหา` = config / สิทธิ์ / การเชื่อมต่อ / rule ของ Realtime Database
- `Firebase หลุดการเชื่อมต่อ` = หน้าเว็บคุยกับ Realtime Database ไม่ได้ชั่วคราว
- `Firebase ตอบกลับแล้ว แต่ยังไม่มีข้อมูลวันนี้` = ฝั่งอุปกรณ์หรือ backend ยังไม่ส่งข้อมูลขึ้นมา
- `ข้อมูลล่าสุดห่างเกิน X นาที` = ข้อมูลหยุดไหลเกินเกณฑ์ที่ตั้งไว้
- `หน้า Front แสดงผลผิดพลาด` = หน้าเว็บ / Leaflet / JavaScript มีปัญหา

ค่าเริ่มต้นของเกณฑ์แจ้งเตือนตั้งไว้ 10 นาที เพราะอุปกรณ์ส่งทุก 5 วินาทีอยู่แล้ว

## พฤติกรรมแจ้งเตือนแบบค้างบนหน้า

- แถบแจ้งเตือนจะแสดงแบบ fixed ด้านขวาบนและค้างอยู่จนกว่าจะกดปิด
- เมื่อกดปุ่ม `ซ่อน 10 นาที` ระบบจะซ่อนแจ้งเตือนชั่วคราว
- ถ้าปัญหายังไม่หาย แถบจะกลับมาแสดงใหม่หลังครบ 10 นาที
- ระหว่างที่ยังไม่กดปิด จะไม่สร้างแจ้งเตือนซ้ำมาทับกัน


## การดึงข้อมูลจาก Firebase (อัปเดต: ลดการดาวน์โหลด)

ทุกหน้าที่อ่าน `locations` ต้องเรียกผ่าน `firebase-queries.js` (`window.FirebaseQueries`) เท่านั้น
และดึงเฉพาะช่วงที่ผู้ใช้ดูอยู่ — **ห้ามอ่าน `ref('locations')` ทั้งก้อน และห้าม `.on()` บน `locations/{id}` ที่ไม่มี `startAt`**

| ฟังก์ชัน | ใช้ทำอะไร |
|---|---|
| `listVehicleIds(db, { mappings, force })` | รายชื่อรถ = `vehicle_mappings` ∪ `GET {databaseURL}/locations.json?shallow=true` (ได้แค่ชื่อ key) cache ใน sessionStorage 10 นาที |
| `fetchRange(db, id, from, to)` | `orderByKey().startAt(from).endAt(to + "")` — from/to เป็น prefix เช่น `2026-11-10`, `2026-11`, `2026` |
| `fetchAfter(db, id, cursor, to?)` | ดึงต่อจาก key ล่าสุด (ผู้เรียกข้าม key == cursor) |
| `listenAfter(db, id, startKey, cb)` | `child_added` เริ่มที่ startKey เสมอ |

พฤติกรรมแต่ละหน้า
- **realtime**: โหลดจุดวันนี้ครั้งเดียว แล้วฟัง `child_added` ต่อจาก key ล่าสุด, resync ทุก 45 วิ (ข้ามเมื่อแท็บซ่อน/ออฟไลน์), render ≤ 1 ครั้ง/วิ, ตาราง 200 แถว + "แสดงเพิ่ม", เขียน cache ลง localStorage ≤ 1 ครั้ง/10 วิ
- **history**: ดึงเฉพาะ [วันที่เริ่ม, วันที่สิ้นสุด] ของรถที่เลือก, cache ในหน่วยความจำ, ช่วง > 7 วัน หรือคาดว่า > 20,000 จุด ต้องยืนยันก่อน, ปุ่ม "โหลดข้อมูล" บังคับดึงใหม่
- **dashboard**: ดึงเฉพาะวัน/เดือน/ปีที่เลือก, ช่วงในอดีต cache ไว้, auto refresh ทุก 60 วิ เฉพาะโหมดวันนี้และแท็บที่มองเห็น

ค่าที่ปรับได้
- `window.FCGPS_POINTS_PER_DAY` (ตั้งก่อนโหลด `history.js`) — จำนวนจุดต่อคันต่อวันที่ใช้ประเมินก่อนโหลดช่วงยาว (ค่าเริ่มต้น 2,880 = ส่งทุก 30 วิ; ถ้าส่งทุก 5 วิ ให้ใช้ 17,280)

## ทดสอบ (Playwright + mock Firebase)

ต้องมี Node.js และ Google Chrome / Microsoft Edge ในเครื่อง (ไม่ต่อ Firebase จริง)

```bash
cd tests
npm install
npm test
```

- `tests/mock-firebase.js` จำลอง compat SDK + REST shallow ด้วยข้อมูลแบบ virtual 5 คัน × 60 วัน × 2,880 จุด/วัน และนับ record ที่ส่งกลับ
- `tests/run-tests.mjs` ตรวจ: grep query ต้องห้าม, จำนวน record ต่อหน้า, cache, debounce, ลบจุด, ตัดเน็ต/ต่อใหม่, ข้ามเที่ยงคืน, เปิดทิ้ง 10 นาที, เวลา render < 50 ms, console error
- `tests/measure.mjs [dir]` วัด read/record ตอนเปิดแต่ละหน้า (ใช้เทียบเวอร์ชัน)

รายละเอียดการเปลี่ยนแปลงและตัวเลข ก่อน/หลัง: ดู `CHANGES.md`
