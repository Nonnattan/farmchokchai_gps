// firebase-queries.js
// จุดเดียวที่อ่าน path `locations` ของ Firebase RTDB สำหรับหน้า realtime / history / dashboard / vehicle-mapping
// กฎ: ห้ามอ่าน ref('locations') ทั้งก้อน และห้าม .on() บน locations/{id} ที่ไม่มี startAt
// key ของจุดเป็น ISO string (เช่น 2026-11-10T10:40:00+07:00) เรียงตามตัวอักษรได้ จึงใช้ orderByKey + startAt/endAt ได้เลย
// (ไม่เปลี่ยน schema ไม่สร้าง node ใหม่ ไม่ต้องเพิ่ม .indexOn)
(function (global) {
  "use strict";

  const KEY_END = "";
  const VEHICLE_IDS_CACHE_KEY = "farmchokchai_vehicle_ids_v1";
  const VEHICLE_IDS_TTL_MS = 10 * 60 * 1000;

  function pad2(n) {
    return String(Math.abs(Number(n) || 0)).padStart(2, "0");
  }

  // "YYYY-MM-DD" ตามเวลาเครื่อง
  function localDateKey(date = new Date()) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function readVehicleIdsCache() {
    try {
      const raw = global.sessionStorage && global.sessionStorage.getItem(VEHICLE_IDS_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.ids) || !Number.isFinite(parsed.at)) return null;
      if (Date.now() - parsed.at > VEHICLE_IDS_TTL_MS || Date.now() < parsed.at) return null;
      return parsed.ids;
    } catch (err) {
      return null;
    }
  }

  function writeVehicleIdsCache(ids) {
    try {
      if (global.sessionStorage) {
        global.sessionStorage.setItem(VEHICLE_IDS_CACHE_KEY, JSON.stringify({ at: Date.now(), ids }));
      }
    } catch (err) {
      // sessionStorage เต็ม/ถูกปิด ไม่เป็นไร
    }
  }

  function clearVehicleIdsCache() {
    try {
      if (global.sessionStorage) global.sessionStorage.removeItem(VEHICLE_IDS_CACHE_KEY);
    } catch (err) {
      // ignore
    }
  }

  function parseMappingsSnapshot(snap) {
    const map = {};
    if (!snap) return map;
    snap.forEach((child) => {
      const value = child.val() || {};
      const vehicleId = String(child.key || value.vehicle_id || "").trim();
      if (!vehicleId) return;
      map[vehicleId] = {
        plate: String(value.plate || value.license_plate || "").trim(),
        note: String(value.note || "").trim(),
        updatedAt: value.updatedAt || value.updated_at || null,
      };
    });
    return map;
  }

  async function getAuthQuery() {
    // หน้าเว็บนี้ไม่ได้โหลด firebase-auth แต่ถ้าวันหนึ่งเปิด auth ไว้ ให้ส่ง token ไปกับ REST ด้วย
    try {
      if (global.firebase && typeof global.firebase.auth === "function") {
        const user = global.firebase.auth().currentUser;
        if (user && typeof user.getIdToken === "function") {
          const token = await user.getIdToken();
          if (token) return `&auth=${encodeURIComponent(token)}`;
        }
      }
    } catch (err) {
      // ignore
    }
    return "";
  }

  // อ่านเฉพาะชื่อ key ลูกของ /locations ผ่าน REST ?shallow=true (ไม่ดาวน์โหลดจุด GPS เลย)
  async function fetchLocationIdsShallow() {
    const config = global.firebaseConfig || {};
    const base = String(config.databaseURL || "").replace(/\/+$/, "");
    if (!base) throw new Error("ไม่พบ databaseURL ใน firebaseConfig");

    const url = `${base}/locations.json?shallow=true${await getAuthQuery()}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`อ่านรายชื่อรถ (shallow) ไม่สำเร็จ: HTTP ${res.status}`);
    }
    const body = await res.json();
    if (!body || typeof body !== "object") return [];
    return Object.keys(body)
      .map((k) => String(k || "").trim())
      .filter(Boolean);
  }

  /**
   * รายชื่อรถ = vehicle_mappings ∪ key ของ /locations (shallow REST)
   * - shallow ถูก cache ใน sessionStorage 10 นาที
   * - ไม่มี fallback ไปอ่าน ref('locations') เต็ม ถ้า shallow ล้มเหลวจะคืน shallowError ให้หน้าแสดง error
   *
   * @param {object} db firebase.database()
   * @param {object} [opts]
   * @param {object} [opts.mappings] mapping ที่หน้าอ่านไว้แล้ว (ส่งมาเพื่อไม่ต้องอ่าน vehicle_mappings ซ้ำ)
   * @param {boolean} [opts.force] ข้าม cache ใน sessionStorage
   * @param {boolean} [opts.skipLocations] ไม่ต้องอ่าน shallow (ใช้เฉพาะ mapping)
   * @returns {Promise<{ids: string[], locationIds: string[], mappingIds: string[], mappings: object, fromCache: boolean, shallowError: Error|null}>}
   */
  async function listVehicleIds(db, opts = {}) {
    let mappings = opts.mappings || null;
    if (!mappings) {
      const snap = await db.ref("vehicle_mappings").once("value");
      mappings = parseMappingsSnapshot(snap);
    }
    const mappingIds = Object.keys(mappings).filter(Boolean);

    let locationIds = [];
    let fromCache = false;
    let shallowError = null;

    if (!opts.skipLocations) {
      const cached = opts.force ? null : readVehicleIdsCache();
      if (cached) {
        locationIds = cached;
        fromCache = true;
      } else {
        try {
          locationIds = await fetchLocationIdsShallow();
          writeVehicleIdsCache(locationIds);
        } catch (err) {
          console.error(err);
          shallowError = err instanceof Error ? err : new Error(String(err));
          locationIds = [];
        }
      }
    }

    const ids = Array.from(new Set([...mappingIds, ...locationIds]));
    return { ids, locationIds: locationIds.slice(), mappingIds, mappings, fromCache, shallowError };
  }

  function vehicleRef(db, vehicleId) {
    const id = String(vehicleId || "").trim();
    if (!id) throw new Error("vehicleId ว่าง");
    return db.ref(`locations/${id}`);
  }

  /**
   * ดึงจุดของรถ 1 คัน ตามช่วง key แบบ prefix
   * fromKey/toKey เป็น prefix ของ ISO เช่น "2026-11-10", "2026-11", "2026" หรือ key เต็ม
   * ช่วง = [fromKey, toKey + ""]
   */
  function fetchRange(db, vehicleId, fromKey, toKey) {
    const from = String(fromKey || "");
    const to = String(toKey || fromKey || "");
    if (!from || !to) return Promise.reject(new Error("fetchRange ต้องระบุช่วงเสมอ"));
    return vehicleRef(db, vehicleId).orderByKey().startAt(from).endAt(to + KEY_END).once("value");
  }

  /**
   * ดึงเฉพาะจุดที่ key >= cursorKey (startAt เป็น inclusive ผู้เรียกต้องข้าม key === cursorKey เอง)
   * ถ้าระบุ toKey จะจำกัดปลายช่วงด้วย endAt(toKey + "")
   */
  function fetchAfter(db, vehicleId, cursorKey, toKey) {
    const cursor = String(cursorKey || "");
    if (!cursor) return Promise.reject(new Error("fetchAfter ต้องมี cursorKey เสมอ"));
    let query = vehicleRef(db, vehicleId).orderByKey().startAt(cursor);
    if (toKey) query = query.endAt(String(toKey) + KEY_END);
    return query.once("value");
  }

  /**
   * ฟัง child_added ของรถ 1 คัน เริ่มที่ startKey เสมอ (ไม่ replay ประวัติทั้งหมด)
   * callback จะไม่ถูกเรียกสำหรับ key === startKey (กันจุดซ้ำของ startAt แบบ inclusive)
   * @returns {function} detach
   */
  function listenAfter(db, vehicleId, startKey, callback, errorCallback) {
    const start = String(startKey || "");
    if (!start) throw new Error("listenAfter ต้องมี startKey เสมอ");
    const query = vehicleRef(db, vehicleId).orderByKey().startAt(start);
    const handler = (snapshot) => {
      if (snapshot.key === start) return;
      callback(snapshot);
    };
    query.on("child_added", handler, errorCallback);
    return () => {
      try {
        query.off("child_added", handler);
      } catch (err) {
        console.warn(err);
      }
    };
  }

  global.FirebaseQueries = Object.freeze({
    KEY_END,
    localDateKey,
    parseMappingsSnapshot,
    listVehicleIds,
    clearVehicleIdsCache,
    fetchRange,
    fetchAfter,
    listenAfter,
  });
})(typeof window !== "undefined" ? window : globalThis);
