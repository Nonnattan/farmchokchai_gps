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

