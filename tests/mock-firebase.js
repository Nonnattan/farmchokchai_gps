// Mock ของ firebase compat (app + database) สำหรับทดสอบเท่านั้น — ไม่ถูกโหลดในหน้าเว็บจริง
// ข้อมูลเป็นแบบ virtual: locations/{veh-NN}/{ISO key} ทุก intervalSec วินาที ย้อนหลัง days วัน จนถึง "ตอนนี้"
// (สร้างค่าตอน query จึงจำลอง 5 คัน × 60 วัน × 2,880 จุด/วัน ได้โดยไม่กินหน่วยความจำ)
// นับทุก record ที่ส่งกลับให้หน้าเว็บใน window.__mock.stats
(function () {
  "use strict";

  const cfg = Object.assign(
    { vehicles: 5, days: 60, intervalSec: 30, latencyMs: 20, withMappings: true, shallowFail: false },
    window.__MOCK_CFG || {},
  );

  const STEP = cfg.intervalSec * 1000;
  const startDay = new Date(Date.now());
  startDay.setHours(0, 0, 0, 0);
  startDay.setDate(startDay.getDate() - (cfg.days - 1));
  const T0 = startDay.getTime();
  const VIDS = Array.from({ length: cfg.vehicles }, (_, i) => `veh-${String(i + 1).padStart(2, "0")}`);

  const mappings = {};
  if (cfg.withMappings) {
    VIDS.forEach((id, i) => {
      mappings[id] = { vehicle_id: id, plate: `กข-${1000 + i}`, note: "", updatedAt: "2026-01-01T00:00:00.000Z" };
    });
  }

  const deleted = Object.create(null); // vid -> Set(key)
  const extras = Object.create(null); // vid -> [{key, value}] (เรียงตาม key)
  VIDS.forEach((id) => {
    deleted[id] = new Set();
    extras[id] = [];
  });

  const stats = {
    reads: [], // { path, start, end, limit, count, t }
    locationRecords: 0,
    mappingRecords: 0,
    childAddedRecords: 0,
    shallowCalls: 0,
    shallowRecords: 0,
    fullLocationsReads: 0,
    unboundedListeners: 0,
    listenersAttached: 0,
    inFlightByPath: Object.create(null),
    overlaps: [],
    maxConcurrent: 0,
    concurrent: 0,
  };

  let online = true;
  const onlineWaiters = [];
  const infoListeners = new Set();
  const childListeners = new Set();

  function pad(n) {
    return String(Math.abs(n)).padStart(2, "0");
  }
  function toIsoWithOffset(date) {
    const tz = -date.getTimezoneOffset();
    const sign = tz >= 0 ? "+" : "-";
    return (
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
      `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
      `${sign}${pad(Math.floor(Math.abs(tz) / 60))}:${pad(Math.abs(tz) % 60)}`
    );
  }
  function keyAt(i) {
    return toIsoWithOffset(new Date(T0 + i * STEP));
  }
  function slotCount() {
    return Math.max(0, Math.floor((Date.now() - T0) / STEP) + 1);
  }
  function valueAt(vid, i) {
    const v = VIDS.indexOf(vid);
    const key = keyAt(i);
    return {
      vehicle_id: vid,
      lat: 13.7 + v * 0.02 + 0.01 * Math.sin(i / 100),
      lng: 100.5 + 0.01 * Math.cos(i / 100),
      speed: 20,
      accuracy: 5,
      timestampiso: key,
    };
  }
  // index แรกที่ keyAt(i) >= s
  function lowerBound(s, n) {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keyAt(mid) < s) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  // index แรกที่ keyAt(i) > s
  function upperBound(s, n) {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keyAt(mid) <= s) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // คืน [[key, value], ...] ของรถ vid ตาม query
  function evaluateVehicle(vid, q) {
    const n = slotCount();
    let lo = q.start != null ? lowerBound(q.start, n) : 0;
    const hi = q.end != null ? upperBound(q.end, n) : n;
    const out = [];
    const del = deleted[vid];
    const ex = extras[vid].filter((e) => (q.start == null || e.key >= q.start) && (q.end == null || e.key <= q.end));
    if (q.limit != null) lo = Math.max(lo, hi - q.limit);
    for (let i = lo; i < hi; i += 1) {
      const k = keyAt(i);
      if (!del.has(k)) out.push([k, valueAt(vid, i)]);
    }
    ex.forEach((e) => {
      if (!del.has(e.key)) out.push([e.key, e.value]);
    });
    if (ex.length) out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if (q.limit != null && out.length > q.limit) return out.slice(out.length - q.limit);
    return out;
  }

  class Snap {
    constructor(key, value, children) {
      this.key = key;
      this._value = value;
      this._children = children || null;
    }
    val() {
      if (this._children) {
        if (!this._children.length) return null;
        const o = {};
        this._children.forEach(([k, v]) => {
          o[k] = v;
        });
        return o;
      }
      return this._value === undefined ? null : this._value;
    }
    exists() {
      return this._children ? this._children.length > 0 : this._value != null;
    }
    numChildren() {
      return this._children ? this._children.length : 0;
    }
    forEach(fn) {
      if (!this._children) return false;
      for (const [k, v] of this._children) {
        if (fn(new Snap(k, v)) === true) return true;
      }
      return false;
    }
  }

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  function waitOnline() {
    if (online) return Promise.resolve();
    return new Promise((r) => onlineWaiters.push(r));
  }

  function parsePath(path) {
    return String(path || "")
      .split("/")
      .filter(Boolean);
  }

  function isVehiclePath(parts) {
    return parts.length === 2 && parts[0] === "locations" && VIDS.includes(parts[1]);
  }

  class Ref {
    constructor(path, q) {
      this.path = parsePath(path).join("/");
      this.q = q || {};
      const parts = parsePath(path);
      this.key = parts.length ? parts[parts.length - 1] : null;
    }
    child(p) {
      return new Ref(`${this.path}/${p}`);
    }
    orderByKey() {
      return new Ref(this.path, Object.assign({}, this.q, { order: "key" }));
    }
    startAt(k) {
      return new Ref(this.path, Object.assign({}, this.q, { start: String(k) }));
    }
    endAt(k) {
      return new Ref(this.path, Object.assign({}, this.q, { end: String(k) }));
    }
    limitToLast(n) {
      return new Ref(this.path, Object.assign({}, this.q, { limit: Number(n) }));
    }

    _evaluate() {
      const parts = parsePath(this.path);
      if (this.path === "vehicle_mappings") {
        const children = Object.keys(mappings)
          .sort()
          .map((k) => [k, mappings[k]]);
        stats.mappingRecords += children.length;
        return new Snap("vehicle_mappings", undefined, children);
      }
      if (this.path === "locations") {
        stats.fullLocationsReads += 1;
        const children = VIDS.map((vid) => {
          const rows = evaluateVehicle(vid, {});
          stats.locationRecords += rows.length;
          const o = {};
          rows.forEach(([k, v]) => {
            o[k] = v;
          });
          return [vid, o];
        });
        return new Snap("locations", undefined, children);
      }
      if (isVehiclePath(parts)) {
        const rows = evaluateVehicle(parts[1], this.q);
        stats.locationRecords += rows.length;
        return new Snap(parts[1], undefined, rows);
      }
      return new Snap(this.key, null);
    }

    async once(type) {
      if (type !== "value") throw new Error(`mock: once(${type}) not supported`);
      const p = this.path;
      stats.inFlightByPath[p] = (stats.inFlightByPath[p] || 0) + 1;
      if (stats.inFlightByPath[p] > 1) stats.overlaps.push({ path: p, q: this.q, t: Date.now() });
      stats.concurrent += 1;
      stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.concurrent);
      try {
        await waitOnline();
        await delay(cfg.latencyMs);
        await waitOnline();
        const before = stats.locationRecords;
        const snap = this._evaluate();
        stats.reads.push({
          path: p,
          start: this.q.start ?? null,
          end: this.q.end ?? null,
          limit: this.q.limit ?? null,
          count: stats.locationRecords - before,
          t: Date.now(),
        });
        return snap;
      } finally {
        stats.inFlightByPath[p] -= 1;
        stats.concurrent -= 1;
      }
    }

    on(type, cb, errCb) {
      if (this.path === ".info/connected" && type === "value") {
        const entry = { cb };
        infoListeners.add(entry);
        setTimeout(() => {
          if (infoListeners.has(entry)) cb(new Snap("connected", online));
        }, cfg.latencyMs + 50); // Firebase จริงตอบ .info/connected หลังต่อ websocket สำเร็จ
        return cb;
      }
      const parts = parsePath(this.path);
      if (type === "child_added" && isVehiclePath(parts)) {
        stats.listenersAttached += 1;
        if (this.q.start == null) stats.unboundedListeners += 1;
        const listener = { ref: this, vid: parts[1], q: this.q, cb, emitted: new Set(), ready: false };
        childListeners.add(listener);
        (async () => {
          await waitOnline();
          await delay(cfg.latencyMs);
          if (!childListeners.has(listener)) return;
          listener.ready = true;
          emitFor(listener);
        })();
        return cb;
      }
      if (errCb) setTimeout(() => errCb(new Error(`mock: on(${type}) at ${this.path} not supported`)), 0);
      return cb;
    }

    off(type, cb) {
      if (this.path === ".info/connected") {
        infoListeners.forEach((e) => {
          if (!cb || e.cb === cb) infoListeners.delete(e);
        });
        return;
      }
      childListeners.forEach((l) => {
        if (l.ref.path === this.path && (!cb || l.cb === cb)) childListeners.delete(l);
      });
    }

    async remove() {
      const parts = parsePath(this.path);
      await delay(cfg.latencyMs);
      if (parts.length === 3 && parts[0] === "locations" && VIDS.includes(parts[1])) {
        deleted[parts[1]].add(parts[2]);
        return;
      }
      if (parts.length === 2 && parts[0] === "vehicle_mappings") {
        delete mappings[parts[1]];
      }
    }

    async set(value) {
      const parts = parsePath(this.path);
      await delay(cfg.latencyMs);
      if (parts.length === 2 && parts[0] === "vehicle_mappings") mappings[parts[1]] = value;
    }
  }

  function emitFor(listener) {
    if (!online || !listener.ready || !childListeners.has(listener)) return;
    const rows = evaluateVehicle(listener.vid, listener.q);
    for (const [k, v] of rows) {
      if (listener.emitted.has(k)) continue;
      listener.emitted.add(k);
      stats.childAddedRecords += 1;
      stats.locationRecords += 1;
      listener.cb(new Snap(k, v));
    }
  }

  function pump() {
    childListeners.forEach((l) => emitFor(l));
  }
  setInterval(pump, 1000);

  function setOnline(value) {
    online = !!value;
    infoListeners.forEach((e) => e.cb(new Snap("connected", online)));
    if (online) {
      onlineWaiters.splice(0).forEach((r) => r());
      pump();
    }
  }

  // shallow REST: GET {databaseURL}/locations.json?shallow=true
  const realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input && input.url;
    if (url && /\/locations\.json\?/.test(url)) {
      if (!/[?&]shallow=true/.test(url)) {
        stats.fullLocationsReads += 1;
        throw new Error("mock: non-shallow REST read of /locations");
      }
      stats.shallowCalls += 1;
      await delay(cfg.latencyMs);
      if (cfg.shallowFail) return new Response("{}", { status: 503 });
      const body = {};
      VIDS.forEach((id) => {
        body[id] = true;
      });
      stats.shallowRecords += VIDS.length;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return realFetch(input, init);
  };

  const db = {
    ref(path) {
      return new Ref(path || "");
    },
    goOffline() {
      setOnline(false);
    },
    goOnline() {
      setOnline(true);
    },
  };

  const apps = [];
  window.firebase = {
    apps,
    initializeApp(config) {
      const app = { name: "[DEFAULT]", options: config };
      apps.push(app);
      return app;
    },
    database() {
      return db;
    },
  };

  window.__mock = {
    cfg,
    stats,
    VIDS,
    T0,
    keyAt,
    pump,
    setOnline,
    isOnline: () => online,
    deleted,
    resetStats() {
      stats.reads = [];
      stats.locationRecords = 0;
      stats.mappingRecords = 0;
      stats.childAddedRecords = 0;
      stats.shallowCalls = 0;
      stats.shallowRecords = 0;
      stats.fullLocationsReads = 0;
      stats.unboundedListeners = 0;
      stats.overlaps = [];
      stats.maxConcurrent = 0;
    },
    // จำนวนจุดที่มีอยู่ของรถ vid ในช่วง key prefix [fromPrefix, toPrefix]
    countRange(vid, fromPrefix, toPrefix) {
      return evaluateVehicle(vid, { start: fromPrefix, end: `${toPrefix}` }).length;
    },
    keysInRange(vid, fromPrefix, toPrefix) {
      return evaluateVehicle(vid, { start: fromPrefix, end: `${toPrefix}` }).map((r) => r[0]);
    },
    // เพิ่มจุดใหม่ (เวลาปัจจุบัน) ให้รถ vid แล้วส่ง child_added ทันที
    emitNow(vid) {
      let d = new Date(Date.now());
      let key = toIsoWithOffset(d);
      const list = extras[vid];
      while (list.some((e) => e.key === key) || key === keyAt(Math.floor((d.getTime() - T0) / STEP))) {
        d = new Date(d.getTime() + 1000);
        key = toIsoWithOffset(d);
      }
      const n = slotCount() - 1;
      const base = valueAt(vid, n);
      list.push({ key, value: Object.assign({}, base, { timestampiso: key }) });
      list.sort((a, b) => (a.key < b.key ? -1 : 1));
      pump();
      return key;
    },
    listenerSummary() {
      return Array.from(childListeners).map((l) => ({ vid: l.vid, start: l.q.start ?? null, end: l.q.end ?? null }));
    },
  };
})();
