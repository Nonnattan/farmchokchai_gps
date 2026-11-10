// history-day-cache.js
// cache จุด GPS ของหน้า history แบบ "รายคัน รายวัน"
// - วันที่ปิดไปแล้ว (เลยเที่ยงคืน + เผื่อเวลาอัปโหลดย้อนหลัง) ข้อมูลไม่เปลี่ยน → เก็บลง IndexedDB ของเบราว์เซอร์
//   เปิดหน้าใหม่ / วันหลังก็ไม่ต้องดาวน์โหลดจาก Firebase ซ้ำ
// - วันนี้ / วันที่เพิ่งปิด เก็บเฉพาะในหน่วยความจำ (ดึงต่อจาก lastKey หรือดึงใหม่)
// ไม่แตะ Firebase เลย ไฟล์นี้จัดการแค่ที่เก็บในเครื่อง
(function (global) {
  "use strict";

  const DB_NAME = "farmchokchai_history_cache_v1";
  const STORE = "days";
  const MAX_PERSISTED_DAYS = 240; // จำนวน "คัน×วัน" สูงสุดใน IndexedDB (เกินแล้วลบอันที่เก็บไว้นานสุด)
  const MAX_MEMORY_DAYS = 90; // จำนวน "คัน×วัน" สูงสุดในหน่วยความจำ
  const FINAL_GRACE_MS = 60 * 60 * 1000; // ถือว่าวันนั้น "ปิด" เมื่อดึงหลังเที่ยงคืนของวันถัดไปอย่างน้อย 1 ชม.

  const memory = new Map(); // id -> entry (LRU ตามลำดับใน Map)
  let dbPromise = null;

  function entryId(vehicleId, day) {
    return `${vehicleId}|${day}`;
  }

  // เวลาสิ้นสุดของวัน (เที่ยงคืนของวันถัดไป ตามเวลาเครื่อง)
  function dayEndMs(day) {
    const d = new Date(`${day}T00:00:00`);
    if (Number.isNaN(d.getTime())) return Infinity;
    d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  // ข้อมูลของวันนั้นครบแล้วหรือยัง (ดึงมาหลังวันปิด + เวลาเผื่อ)
  function isFinal(day, savedAt) {
    return Number.isFinite(savedAt) && savedAt >= dayEndMs(day) + FINAL_GRACE_MS;
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      try {
        if (!global.indexedDB) return resolve(null);
        const req = global.indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            const store = db.createObjectStore(STORE, { keyPath: "id" });
            store.createIndex("savedAt", "savedAt");
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null); // เช่นโหมดส่วนตัว: ใช้แค่หน่วยความจำ
        req.onblocked = () => resolve(null);
      } catch (err) {
        resolve(null);
      }
    });
    return dbPromise;
  }

  function idbRequest(storeMode, fn) {
    return openDb().then(
      (db) =>
        new Promise((resolve) => {
          if (!db) return resolve(null);
          try {
            const tx = db.transaction(STORE, storeMode);
            const result = fn(tx.objectStore(STORE));
            tx.oncomplete = () => resolve(result && "result" in result ? result.result : true);
            tx.onerror = () => resolve(null);
            tx.onabort = () => resolve(null);
          } catch (err) {
            resolve(null);
          }
        }),
    );
  }

  function remember(entry) {
    memory.delete(entry.id);
    memory.set(entry.id, entry);
    while (memory.size > MAX_MEMORY_DAYS) {
      memory.delete(memory.keys().next().value);
    }
  }

  async function trimPersisted() {
    await idbRequest("readwrite", (store) => {
      const countReq = store.count();
      countReq.onsuccess = () => {
        let excess = countReq.result - MAX_PERSISTED_DAYS;
        if (excess <= 0) return;
        store.index("savedAt").openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor || excess <= 0) return;
          cursor.delete();
          excess -= 1;
          cursor.continue();
        };
      };
      return null;
    });
  }

  /**
   * อ่าน cache ของรถ 1 คัน 1 วัน
   * @returns {Promise<{id, vehicleId, day, rows, lastKey, savedAt, final}|null>}
   *   rows = [[key, lat, lng, speed, accuracy, timestampiso|null], ...] เรียงตาม key
   */
  async function get(vehicleId, day) {
    const id = entryId(vehicleId, day);
    const inMemory = memory.get(id);
    if (inMemory) {
      remember(inMemory);
      return inMemory;
    }
    const stored = await idbRequest("readonly", (store) => store.get(id));
    if (stored && Array.isArray(stored.rows)) {
      const entry = { ...stored, final: isFinal(stored.day, stored.savedAt) };
      remember(entry);
      return entry;
    }
    return null;
  }

  /** บันทึก cache ของรถ 1 คัน 1 วัน (เขียนลง IndexedDB เฉพาะวันที่ปิดแล้ว) */
  async function put(vehicleId, day, rows, savedAt = Date.now()) {
    const id = entryId(vehicleId, day);
    const lastKey = rows.length ? rows[rows.length - 1][0] : null;
    const entry = { id, vehicleId, day, rows, lastKey, savedAt, final: isFinal(day, savedAt) };
    remember(entry);
    if (entry.final) {
      const { final, ...persisted } = entry;
      await idbRequest("readwrite", (store) => store.put(persisted));
      trimPersisted();
    }
    return entry;
  }

  /** ลบจุด 1 จุดออกจาก cache (ใช้หลังลบจุดใน Firebase สำเร็จ) */
  async function removeKey(vehicleId, day, key) {
    const entry = await get(vehicleId, day);
    if (!entry) return;
    const rows = entry.rows.filter((r) => r[0] !== key);
    if (rows.length === entry.rows.length) return;
    const updated = { ...entry, rows, lastKey: rows.length ? rows[rows.length - 1][0] : null };
    remember(updated);
    if (updated.final) {
      const { final, ...persisted } = updated;
      await idbRequest("readwrite", (store) => store.put(persisted));
    }
  }

  global.HistoryDayCache = Object.freeze({ get, put, removeKey, isFinal });
})(typeof window !== "undefined" ? window : globalThis);
