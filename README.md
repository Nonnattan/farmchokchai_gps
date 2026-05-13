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
