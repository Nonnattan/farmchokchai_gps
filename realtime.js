const { createApp, markRaw } = Vue;
const FQ = window.FirebaseQueries;

let firebaseDb = null;
let mapInstance = null;
let mapCanvasRenderer = null;
let routeLayers = [];
let pointLayers = [];
let vehicleLayerStates = Object.create(null);
let vehicleLiveRefs = Object.create(null);
let vehicleLiveCallbacks = Object.create(null);
let firebaseInfoRef = null;
let firebaseInfoCallback = null;
// เก็บ key ล่าสุดที่ sync แล้วของแต่ละคัน ใช้เป็น cursor ให้ child_added / periodic resync
// จะได้ไม่ต้องโหลดข้อมูลทั้งวันซ้ำทุกครั้ง (ไม่แก้ Firebase schema ใด ๆ)
let vehicleLastKey = Object.create(null);
let periodicSyncTimer = null;
let visibilityChangeHandler = null;

// ✅ ใหม่: เก็บวันที่ปัจจุบันเพื่อตรวจสอบการเปลี่ยนวัน
let currentCacheDate = localDateKey(new Date());

const ROUTE_CACHE_PREFIX = "farmchokchai_realtime_route_cache_v1";
const ROUTE_CACHE_MAX_POINTS = 6000;
// ✅ ใหม่: เก็บ lastKey ของแต่ละ vehicle ใน localStorage เพื่อ persistence
const LAST_KEY_CACHE_PREFIX = "farmchokchai_realtime_lastkey_v1";

// ---- ประสิทธิภาพ: state ที่ไม่ต้องเป็น reactive ----
const RENDER_MIN_INTERVAL_MS = 1000; // commit + render ไม่เกิน 1 ครั้ง/วินาที
const ROUTE_CACHE_WRITE_INTERVAL_MS = 10000; // เขียน localStorage ไม่เกิน 1 ครั้ง/10 วิ
const PERIODIC_RESYNC_MS = 45000;
const TABLE_PAGE_SIZE = 200;
// เส้นทางบนแผนที่แบ่งเป็นท่อนละไม่เกินกี่จุด (ภาพเหมือนเดิม แต่ canvas วาดใหม่แค่ท่อนท้ายเมื่อมีจุดใหม่)
const POLYLINE_CHUNK_POINTS = 250;
// จุดของวันนี้ต่อคัน (array ไม่เปลี่ยนค่า: ทุกครั้งที่มีจุดใหม่จะได้ array ใหม่) + set ของ key กันจุดซ้ำแบบ O(1)
let routePointCache = Object.create(null);
let routeKeySets = Object.create(null);
let liveDetachers = Object.create(null);
let liveSessionId = 0; // เพิ่มทุกครั้งที่ subscribe ใหม่ ใช้ทิ้งผลของรอบเก่า
let resyncInFlight = false;
let renderLastAt = 0;
let routeCacheDirty = new Set();
let routeCacheTimer = null;
let pageHideHandler = null;
let liveResult = null; // ข้อมูลล่าสุดของแต่ละคันที่รอ commit เข้า vehiclesById
// สถานะ .info/connected สำหรับข้าม resync ตอนออฟไลน์ (แยกจาก firebaseConnected ที่ใช้แสดงผลเดิม)
let rtdbConnected = null;
let rtdbConnectedRef = null;
let rtdbConnectedCallback = null;
// memo ของ segments/distance ต่อ array ของจุด (คำนวณใหม่เฉพาะคันที่มีจุดใหม่)
const routeMetricsMemo = new WeakMap();

function pointKeyOf(p) {
  return p ? p.key || p.timestampiso : undefined;
}

// คำนวณ pointNo / ระยะสะสม ตั้งแต่ index startIdx (ตรรกะเดียวกับ normalizeRoutePoints)
function recomputeRouteMetrics(points, startIdx = 0) {
  for (let idx = Math.max(0, startIdx); idx < points.length; idx += 1) {
    const p = points[idx];
    p.pointNo = idx + 1;
    if (idx === 0) {
      p.segmentMeters = 0;
      p.cumulativeMeters = 0;
    } else {
      const prev = points[idx - 1];
      p.segmentMeters = haversineMeters(prev.lat, prev.lng, p.lat, p.lng);
      p.cumulativeMeters = (prev.cumulativeMeters || 0) + (p.segmentMeters || 0);
    }
    p.cumulativeKm = (p.cumulativeMeters || 0) / 1000;
  }
  return points;
}

function syncFirebaseBadge(connected, message) {
  if (typeof window.setFirebaseNavStatus === 'function') {
    window.setFirebaseNavStatus(connected, message);
  }
}

function toIsoWithOffset(date = new Date()) {
  const tz = -date.getTimezoneOffset();
  const sign = tz >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(tz) / 60)).padStart(2, "0");
  const mm = String(Math.abs(tz) % 60).padStart(2, "0");

  return (
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}` +
    `T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}` +
    `${sign}${hh}:${mm}`
  );
}

function getTodayKeyRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return {
    startKey: toIsoWithOffset(start),
    endKey: toIsoWithOffset(end),
  };
}

const COLORS = [
  "#38bdf8", "#f59e0b", "#22c55e", "#a855f7",
  "#ef4444", "#14b8a6", "#eab308", "#f97316",
  "#06b6d4", "#8b5cf6", "#84cc16", "#ec4899",
];

function formatNum(n, digits = 6) {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) : "-";
}

function formatInt(n) {
  return typeof n === "number" && Number.isFinite(n) ? String(Math.round(n)) : "-";
}

function toDateSafe(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "object") {
    if (typeof value.toDate === "function") {
      const d = value.toDate();
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
    }
    if (typeof value.seconds === "number") {
      const ms =
        value.seconds * 1000 +
        (typeof value.nanoseconds === "number" ? value.nanoseconds / 1e6 : 0);
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d;
    }
  }

  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function pad(n) {
  return String(Math.abs(n)).padStart(2, "0");
}

function colorForId(vehicleId) {
  let hash = 0;
  for (let i = 0; i < vehicleId.length; i += 1) {
    hash = (hash * 31 + vehicleId.charCodeAt(i)) >>> 0;
  }
  return COLORS[hash % COLORS.length];
}

function getTodayBounds() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function localDateKey(date = new Date()) {
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-");
}

function getRouteCacheStorageKey(vehicleId, date = new Date()) {
  return `${ROUTE_CACHE_PREFIX}:${localDateKey(date)}:${String(vehicleId || "").trim()}`;
}

// ✅ ใหม่: ฟังก์ชันเก็บ/อ่าน lastKey สำหรับแต่ละ vehicle ของวันนี้
function getLastKeyCacheStorageKey(vehicleId, date = new Date()) {
  return `${LAST_KEY_CACHE_PREFIX}:${localDateKey(date)}:${String(vehicleId || "").trim()}`;
}

function readLastKeyCache(vehicleId, date = new Date()) {
  if (typeof window === "undefined" || !window.localStorage) return null;
  try {
    return localStorage.getItem(getLastKeyCacheStorageKey(vehicleId, date)) || null;
  } catch (err) {
    console.warn(err);
    return null;
  }
}

function writeLastKeyCache(vehicleId, lastKey, date = new Date()) {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    if (lastKey) {
      localStorage.setItem(getLastKeyCacheStorageKey(vehicleId, date), String(lastKey));
    }
  } catch (err) {
    console.warn(err);
  }
}

// ✅ ใหม่: ล้าง cache ของวันเก่า
function clearOldCaches(currentDate = new Date()) {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    const todayKey = localDateKey(currentDate);
    const keysToDelete = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;

      // ตรวจสอบว่าเป็น cache ของเรา และไม่ใช่วันนี้
      if ((key.startsWith(ROUTE_CACHE_PREFIX) || key.startsWith(LAST_KEY_CACHE_PREFIX)) && !key.includes(todayKey)) {
        keysToDelete.push(key);
      }
    }

    keysToDelete.forEach(key => localStorage.removeItem(key));
  } catch (err) {
    console.warn(err);
  }
}

function serializePointForCache(point) {
  if (!point) return null;
  return {
    key: point.key || null,
    lat: point.lat,
    lng: point.lng,
    speed: point.speed ?? null,
    accuracy: point.accuracy ?? null,
    timestampiso: point.timestampiso || null,
  };
}

function rehydratePointFromCache(raw) {
  if (!raw) return null;
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const timestampiso = String(raw.timestampiso || raw.key || "");
  const date = toDateSafe(timestampiso);
  if (!date) return null;

  return {
    key: raw.key || timestampiso,
    lat,
    lng,
    speed: Number.isFinite(Number(raw.speed)) ? Number(raw.speed) : null,
    accuracy: Number.isFinite(Number(raw.accuracy)) ? Number(raw.accuracy) : null,
    timestampiso,
    date,
    raw: null,
    pointNo: 0,
    segmentMeters: 0,
    cumulativeMeters: 0,
    cumulativeKm: 0,
  };
}

function readRouteCache(vehicleId, date = new Date()) {
  if (typeof window === "undefined" || !window.localStorage) return [];
  try {
    const raw = localStorage.getItem(getRouteCacheStorageKey(vehicleId, date));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(rehydratePointFromCache).filter(Boolean);
  } catch (err) {
    console.warn(err);
    return [];
  }
}

function writeRouteCache(vehicleId, points, date = new Date()) {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    const simplified = (Array.isArray(points) ? points : [])
      .map(serializePointForCache)
      .filter(Boolean)
      .slice(-ROUTE_CACHE_MAX_POINTS);
    localStorage.setItem(getRouteCacheStorageKey(vehicleId, date), JSON.stringify(simplified));
  } catch (err) {
    console.warn(err);
  }
}

createApp({
  data() {
    return {
      loading: false,
      status: "กำลังรอข้อมูลรถล่าสุด...",
      statusType: "info",
      gapMinutesInput: "10",
      staleMinutesInput: "10",
      vehiclesById: {},
      visibleVehicles: {},
      vehicleMappings: {},
      routeCacheDateKey: localDateKey(new Date()),
      lastRefreshAt: null,
      tableLimit: TABLE_PAGE_SIZE,
      mapReady: false,
      resizeHandler: null,
      renderPending: false,
      renderTimer: null,
      renderNeedsFit: false,
      renderNeedsCommit: false,
      dayChangePending: false,
      initialAutoFitDone: false,
      healthPulse: 0,
      healthTimer: null,

      // แจ้งเตือนเมื่อวันนี้ยังไม่มีข้อมูล
      noDataToday: false,
      noDataCheckedAt: null,
      notificationSupported: typeof window !== "undefined" && "Notification" in window,
      notificationPermission:
        typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported",
      noDataNotifiedFor: "",
      staleNotifiedFor: "",
      alertRepeatMinutes: 10,
      healthNotificationLastSignature: "",
      healthNotificationLastShownAt: 0,
      healthNotificationPausedUntil: 0,
      firebaseConnected: null,
      firebaseLastError: "",
      renderError: "",
      lastSnapshotAt: null,

      // ตัวกรองในตาราง
      filterVehicle: "",
      filterStartTime: "",
      filterEndTime: "",
      filterHourSlot: "",
    };
  },
  computed: {
    gapThresholdMinutes() {
      const n = Number(this.gapMinutesInput);
      return Number.isFinite(n) && n >= 0 ? n : 10;
    },
    gapThresholdMs() {
      return this.gapThresholdMinutes * 60 * 1000;
    },
    staleThresholdMinutes() {
      const n = Number(this.staleMinutesInput);
      return Number.isFinite(n) && n >= 0 ? n : 10;
    },
    staleThresholdMs() {
      return this.staleThresholdMinutes * 60 * 1000;
    },

    vehicleLabelMap() {
      return this.vehicleMappings || {};
    },

    vehicleSummaries() {
      const entries = Object.entries(this.vehiclesById).map(([vehicleId, data]) => {
        const color = colorForId(vehicleId);
        const points = data.points || [];
        const { segments, distanceKm } = this.routeMetrics(points);
        const latest = points[points.length - 1] || null;
        const latestTime = latest?.date ? latest.date.getTime() : 0;
        const plateText = this.vehicleLabelMap[vehicleId]?.plate || "";
        const displayLabel = vehicleId ? (plateText ? `${vehicleId} → ${plateText}` : vehicleId) : "";

        return {
          vehicleId,
          color,
          points,
          segments,
          distanceKm,
          distanceText: `${distanceKm.toFixed(2)} km`,
          pointCount: points.length,
          segmentCount: segments.filter((s) => s.length >= 2).length,
          latest,
          latestTime,
          lastUpdatedAt: data.lastSeenAt || null,
          lastSeenAt: data.lastSeenAt || null,
          plateText,
          displayLabel,
        };
      });

      entries.sort((a, b) => {
        const ta = a.latestTime || 0;
        const tb = b.latestTime || 0;
        if (tb !== ta) return tb - ta;
        return a.vehicleId.localeCompare(b.vehicleId, "th");
      });

      return entries;
    },
    visibleVehicleSummaries() {
      return this.vehicleSummaries.filter((v) => this.visibleVehicles[v.vehicleId] !== false);
    },
    // จำนวนจุดของรถที่แสดง (เดิมคือ visiblePoints.length แต่ไม่ต้อง clone ทุกจุด)
    visiblePointCount() {
      let total = 0;
      for (const vehicle of this.visibleVehicleSummaries) total += vehicle.points.length;
      return total;
    },
    // ตัวกรองของตาราง (ตรรกะเดิมของ filteredPoints)
    tablePointMatcher() {
      const filterVehicle = this.filterVehicle;
      const slot = this.filterHourSlot !== "" ? Number(this.filterHourSlot) : NaN;
      const useSlot = this.filterHourSlot !== "" && Number.isFinite(slot);
      const startTime = this.filterStartTime;
      const endTime = this.filterEndTime;

      return (p, vehicleId) => {
        if (filterVehicle && vehicleId !== filterVehicle) return false;

        if (useSlot && p.date) {
          if (p.date.getHours() !== slot) return false;
        }

        if (p.date && (startTime || endTime)) {
          const timeStr = `${pad(p.date.getHours())}:${pad(p.date.getMinutes())}`;
          if (startTime && timeStr < startTime) return false;
          if (endTime && timeStr > endTime) return false;
        }

        return true;
      };
    },
    tableFiltersActive() {
      return !!(this.filterVehicle || this.filterHourSlot !== "" || this.filterStartTime || this.filterEndTime);
    },
    // จำนวนแถวทั้งหมดหลังกรอง (ใช้กับปุ่ม "แสดงเพิ่ม")
    filteredPointCount() {
      if (!this.tableFiltersActive) return this.visiblePointCount;
      const match = this.tablePointMatcher;
      let count = 0;
      for (const vehicle of this.visibleVehicleSummaries) {
        if (this.filterVehicle && vehicle.vehicleId !== this.filterVehicle) continue;
        const pts = vehicle.points;
        for (let i = 0; i < pts.length; i += 1) {
          if (match(pts[i], vehicle.vehicleId)) count += 1;
        }
      }
      return count;
    },
    // แถวของตาราง: ล่าสุดก่อน (เรียงแบบเดิม: เวลาใหม่ก่อน, เวลาเท่ากันเรียงตาม vehicleId)
    // แสดงแค่ tableLimit แถว (เริ่ม 200) ด้วยการ merge จากท้าย array ของแต่ละคัน ไม่ต้อง clone+sort ทุกจุด
    filteredPoints() {
      const limit = Math.max(0, Number(this.tableLimit) || TABLE_PAGE_SIZE);
      const match = this.tablePointMatcher;
      const cursors = [];

      for (const vehicle of this.visibleVehicleSummaries) {
        if (this.filterVehicle && vehicle.vehicleId !== this.filterVehicle) continue;
        if (!vehicle.points.length) continue;
        cursors.push({ vehicle, idx: vehicle.points.length - 1 });
      }

      const rows = [];
      while (rows.length < limit && cursors.length) {
        let best = -1;
        let bestTime = 0;
        for (let c = 0; c < cursors.length; c += 1) {
          const cur = cursors[c];
          const p = cur.vehicle.points[cur.idx];
          const t = p.date ? p.date.getTime() : 0;
          if (
            best === -1 ||
            t > bestTime ||
            (t === bestTime &&
              String(cur.vehicle.vehicleId || "").localeCompare(String(cursors[best].vehicle.vehicleId || ""), "th") < 0)
          ) {
            best = c;
            bestTime = t;
          }
        }

        const cur = cursors[best];
        const vehicle = cur.vehicle;
        const p = vehicle.points[cur.idx];
        cur.idx -= 1;
        if (cur.idx < 0) cursors.splice(best, 1);

        if (!match(p, vehicle.vehicleId)) continue;
        rows.push({
          ...p,
          vehicleId: vehicle.vehicleId,
          color: vehicle.color,
          displayLabel: vehicle.displayLabel || vehicle.vehicleId,
          plateText: vehicle.plateText || "",
        });
      }

      return rows;
    },
    totalVehiclesText() {
      return String(this.visibleVehicleSummaries.length);
    },
    totalPointsText() {
      return String(this.visiblePointCount);
    },
    lastUpdatedText() {
      const times = this.vehicleSummaries
        .map((v) => v.lastSeenAt)
        .filter(Boolean)
        .map((t) => toDateSafe(t))
        .filter(Boolean)
        .map((d) => d.getTime());

      if (!times.length) return "-";
      return this.formatDateTime(new Date(Math.max(...times)));
    },
    latestDataTimestampMs() {
      const times = this.vehicleSummaries
        .map((v) => v.latestTime || 0)
        .filter((n) => Number.isFinite(n) && n > 0);
      return times.length ? Math.max(...times) : null;
    },
    latestDataAgeMs() {
      this.healthPulse;
      const ts = this.latestDataTimestampMs;
      if (!ts) return null;
      return Date.now() - ts;
    },
    healthState() {
      const latestAgeMs = this.latestDataAgeMs;
      const latestAgeMinutes = latestAgeMs == null ? null : latestAgeMs / 60000;
      const latestAgeText =
        latestAgeMs == null
          ? "-"
          : latestAgeMs < 1000
            ? "ไม่ถึง 1 วิ"
            : latestAgeMs < 60000
              ? `${Math.max(1, Math.round(latestAgeMs / 1000))} วินาที`
              : `${Math.round(latestAgeMinutes)} นาที`;

      if (this.firebaseLastError) {
        return {
          kind: "firebase_error",
          tone: "error",
          title: "Firebase มีปัญหา",
          detail: this.firebaseLastError,
          source: "ฝั่ง Firebase",
          action: "ตรวจ config, permission, rule และ network",
          latestAgeText,
          visible: true,
          signature: `firebase_error:${String(this.firebaseLastError).slice(0, 120)}`,
        };
      }

      if (this.firebaseConnected === false) {
        return {
          kind: "firebase_offline",
          tone: "error",
          title: "Firebase หลุดการเชื่อมต่อ",
          detail: "หน้าเว็บติดต่อ Realtime Database ไม่ได้ในขณะนี้",
          source: "ฝั่ง Firebase / Network",
          action: "ตรวจอินเทอร์เน็ต, Realtime Database และสิทธิ์เข้าถึง",
          latestAgeText,
          visible: true,
          signature: "firebase_offline",
        };
      }

      if (this.renderError) {
        return {
          kind: "front_error",
          tone: "error",
          title: "หน้า Front แสดงผลผิดพลาด",
          detail: this.renderError,
          source: "ฝั่ง Front-end",
          action: "ตรวจไฟล์ JS, Leaflet และ DOM ของหน้า realtime",
          latestAgeText,
          visible: true,
          signature: `front_error:${String(this.renderError).slice(0, 120)}`,
        };
      }

      if (latestAgeMs == null) {
        return {
          kind: "no_data",
          tone: "warn",
          title: "Firebase ตอบกลับแล้ว แต่ยังไม่มีข้อมูลวันนี้",
          detail: "ยังไม่พบจุด GPS ของวันนี้จากอุปกรณ์หรือ backend ที่ส่งขึ้น Firebase",
          source: "ฝั่งอุปกรณ์ / uploader / backend",
          action: "ตรวจอุปกรณ์ที่ส่งข้อมูลทุก 5 วิ",
          latestAgeText,
          visible: true,
          signature: "no_data",
        };
      }

      if (latestAgeMs < this.staleThresholdMs) {
        return {
          kind: "ok",
          tone: "ok",
          title: `ข้อมูลล่าสุด ${latestAgeText}`,
          detail: "",
          source: "",
          action: "",
          latestAgeText,
          visible: false,
          signature: "ok",
        };
      }

      return {
        kind: "stale",
        tone: "warn",
        title: `ข้อมูลเก่า ${latestAgeText} (เกิน ${this.staleThresholdMinutes} นาที)`,
        detail: "ข้อมูลล่าสุดจากเครื่องไม่ได้ส่งเข้า Firebase มาสักพักแล้ว",
        source: "ฝั่งอุปกรณ์ / uploader / backend",
        action: "ตรวจอุปกรณ์ GPS, Network และ uploader",
        latestAgeText,
        visible: true,
        signature: `stale:${latestAgeMs}`,
      };
    },
  },
  watch: {
    // เปลี่ยนตัวกรองตาราง → กลับไปแสดง 200 แถวแรก
    filterVehicle() {
      this.tableLimit = TABLE_PAGE_SIZE;
    },
    filterHourSlot() {
      this.tableLimit = TABLE_PAGE_SIZE;
    },
  },
  methods: {
    showMoreRows() {
      this.tableLimit += TABLE_PAGE_SIZE;
    },
    routeMetrics(points) {
      const gapMs = this.gapThresholdMs;
      const cached = routeMetricsMemo.get(points);
      if (cached && cached.gapMs === gapMs) return cached;
      const segments = this.buildSegments(points);
      const metrics = { gapMs, segments, distanceKm: this.distanceKmFromSegments(segments) };
      routeMetricsMemo.set(points, metrics);
      return metrics;
    },
    // ให้ template เรียก pad() ได้
    pad(n) {
      return pad(n);
    },
    setStatus(text, type = "info") {
      this.status = text;
      this.statusType = type;
    },
    formatDuration(ms) {
      if (ms == null || !Number.isFinite(ms) || ms < 0) return "-";
      if (ms < 1000) return "น้อยกว่า 1 วิ";
      const totalSeconds = Math.floor(ms / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      if (minutes <= 0) return `${seconds} วินาที`;
      if (seconds === 0) return `${minutes} นาที`;
      return `${minutes} นาที ${seconds} วินาที`;
    },
    async enableBrowserNotification() {
      if (!this.notificationSupported) {
        this.setStatus("เบราว์เซอร์นี้ไม่รองรับ Notification", "warn");
        return false;
      }

      try {
        const permission = await Notification.requestPermission();
        this.notificationPermission = permission;
        if (permission === "granted") {
          this.setStatus("เปิดการแจ้งเตือนบนเบราว์เซอร์แล้ว", "ok");
          this.refreshHealthState(true);
          return true;
        }

        this.setStatus("ยังไม่ได้อนุญาตการแจ้งเตือนบนเบราว์เซอร์", "warn");
        return false;
      } catch (err) {
        console.error(err);
        this.setStatus(`ขออนุญาตแจ้งเตือนไม่สำเร็จ: ${err.message || err}`, "warn");
        return false;
      }
    },
    dismissHealthAlert() {
      const state = this.healthState;
      if (!state.visible) return;

      const now = Date.now();
      this.healthNotificationPausedUntil = now + this.alertRepeatMinutes * 60 * 1000;
      this.healthNotificationLastSignature = state.signature;
      this.healthNotificationLastShownAt = now;
      this.setStatus(`ซ่อนการแจ้งเตือนชั่วคราว ${this.alertRepeatMinutes} นาที`, "info");
    },
    syncStickyAlertState(state = this.healthState) {
      if (!state.visible) {
        return;
      }

      const now = Date.now();
      const suppressed = now < this.healthNotificationPausedUntil;

      if (state.kind === "ok") return;

      if (suppressed) {
        return;
      }

      if (this.notificationSupported && this.notificationPermission === "granted") {
        this.maybeNotifyHealthState(state);
      }
    },
    maybeNotifyHealthState(state = this.healthState, force = false) {
      if (!state.visible) return false;

      const now = Date.now();
      if (now < this.healthNotificationPausedUntil) return false;

      if (!force && this.healthNotificationLastSignature === state.signature) {
        const repeatMs = this.alertRepeatMinutes * 60 * 1000;
        if (now - this.healthNotificationLastShownAt < repeatMs) {
          return false;
        }
      }

      if (!this.notificationSupported || this.notificationPermission !== "granted") {
        return false;
      }

      try {
        new Notification("Farm Chokchai GPS", {
          body: `${state.title}
${state.action}`.trim(),
          tag: "farmchokchai-health",
          renotify: true,
          requireInteraction: true,
        });
        this.healthNotificationLastSignature = state.signature;
        this.healthNotificationLastShownAt = now;
        return true;
      } catch (err) {
        console.warn(err);
        return false;
      }
    },
    updateNoDataState(count) {
      const key = localDateKey();
      this.noDataToday = count === 0;
      this.noDataCheckedAt = new Date().toISOString();

      if (!this.noDataToday) {
        this.noDataNotifiedFor = "";
        return;
      }

      this.setStatus("วันนี้ยังไม่มีข้อมูล GPS เข้าระบบ", "warn");
      this.maybeNotifyNoData(false, key);
    },
    maybeNotifyNoData(force = false, key = localDateKey()) {
      if (!this.noDataToday) return;

      const stateSignature = `no_data:${key}`;
      const now = Date.now();
      const repeatMs = this.alertRepeatMinutes * 60 * 1000;

      if (now < this.healthNotificationPausedUntil) return;
      if (!force && this.healthNotificationLastSignature === stateSignature) {
        if (now - this.healthNotificationLastShownAt < repeatMs) return;
      }

      if (!this.notificationSupported || this.notificationPermission !== "granted") {
        return;
      }

      try {
        const body = "ขณะนี้ยังไม่มีข้อมูลรถส่งเข้าระบบในวันนี้";
        new Notification("Farm Chokchai GPS", {
          body,
          tag: "farmchokchai-health",
          renotify: true,
          requireInteraction: true,
        });
        this.noDataNotifiedFor = key;
        this.healthNotificationLastSignature = stateSignature;
        this.healthNotificationLastShownAt = now;
      } catch (err) {
        console.warn(err);
      }
    },
    maybeNotifyStaleData(force = false) {
      if (this.healthState.kind !== "stale") return;

      const stateSignature = `stale:${this.latestDataTimestampMs}`;
      const now = Date.now();
      const repeatMs = this.alertRepeatMinutes * 60 * 1000;

      if (now < this.healthNotificationPausedUntil) return;
      if (!force && this.healthNotificationLastSignature === stateSignature) {
        if (now - this.healthNotificationLastShownAt < repeatMs) return;
      }

      if (!this.notificationSupported || this.notificationPermission !== "granted") return;

      try {
        new Notification("Farm Chokchai GPS", {
          body: `${this.healthState.title}
${this.healthState.action}`,
          tag: "farmchokchai-health",
          renotify: true,
          requireInteraction: true,
        });
        this.staleNotifiedFor = this.latestDataTimestampMs;
        this.healthNotificationLastSignature = stateSignature;
        this.healthNotificationLastShownAt = now;
      } catch (err) {
        console.warn(err);
      }
    },
    refreshHealthState(notify = false) {
      const state = this.healthState;

      if (state.kind === "ok") {
        this.noDataToday = false;
        this.noDataNotifiedFor = "";
        this.staleNotifiedFor = "";
        this.healthNotificationPausedUntil = 0;
        this.healthNotificationLastSignature = "";
        this.healthNotificationLastShownAt = 0;
        if (this.statusType !== "error") {
          this.setStatus(state.title, "ok");
        }
        return state;
      }

      if (state.kind === "no_data") {
        this.noDataToday = true;
        this.noDataCheckedAt = new Date().toISOString();
        this.setStatus(state.title, "warn");
      } else if (state.kind === "stale") {
        this.noDataToday = false;
        this.setStatus(state.title, "warn");
      } else if (state.kind === "firebase_offline") {
        this.setStatus(state.title, "error");
      } else if (state.kind === "firebase_error") {
        this.setStatus(state.title, "error");
      } else if (state.kind === "front_error") {
        this.setStatus(state.title, "error");
      }

      if (state.visible) {
        this.syncStickyAlertState(state);
        if (notify) {
          if (state.kind === "no_data") this.maybeNotifyNoData(false);
          if (state.kind === "stale") this.maybeNotifyStaleData(false);
          if (state.kind === "firebase_error" || state.kind === "firebase_offline" || state.kind === "front_error") {
            this.maybeNotifyHealthState(state);
          }
        }
      }

      return state;
    },
    formatDateTime(value) {
      const d = toDateSafe(value);
      if (!d) return "-";
      return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(
        d.getHours(),
      )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    },
    formatCoord(value) {
      return formatNum(value, 6);
    },
    formatSpeed(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "-";
      return `${value.toFixed(1)} km/h`;
    },
    formatAccuracy(value) {
      return typeof value === "number" && Number.isFinite(value)
        ? `${formatInt(value)} m`
        : "-";
    },
    initFirebase() {
      if (!window.firebaseConfig || !window.firebaseConfig.apiKey) {
        this.firebaseLastError = "ยังไม่ตั้งค่า Firebase config";
        this.setStatus("ยังไม่ตั้งค่า Firebase config", "warn");
        return false;
      }
      try {
        if (!firebase.apps.length) firebase.initializeApp(window.firebaseConfig);
        if (!firebaseDb) firebaseDb = firebase.database();
        return true;
      } catch (err) {
        console.error(err);
        this.firebaseLastError = `เริ่ม Firebase ไม่สำเร็จ: ${err.message || err}`;
        this.setStatus(this.firebaseLastError, "error");
        return false;
      }
    },
    detachFirebaseInfoListener() {
      if (firebaseInfoRef && firebaseInfoCallback) {
        try {
          firebaseInfoRef.off("value", firebaseInfoCallback);
        } catch (err) {
          console.warn(err);
        }
      }
      firebaseInfoRef = null;
      firebaseInfoCallback = null;
    },
    subscribeFirebaseConnectionState() {
      if (!this.initFirebase()) return;
      this.detachFirebaseInfoListener();

      firebaseInfoRef = firebaseDb.ref(".info/connected");
      firebaseInfoCallback = (snapshot) => {
        this.firebaseConnected = !!snapshot.val();
        syncFirebaseBadge(this.firebaseConnected, this.firebaseConnected ? "เชื่อมต่อ Firebase ได้ปกติ" : "เชื่อมต่อไม่ได้");
        if (this.firebaseConnected) {
          this.firebaseLastError = "";
        } else {
          this.setStatus("Firebase กำลังหลุดการเชื่อมต่อ", "warn");
        }
        this.refreshHealthState();
      };

      firebaseInfoRef.on(
        "value",
        firebaseInfoCallback,
        (err) => {
          console.error(err);
          this.firebaseLastError = `อ่านสถานะการเชื่อมต่อ Firebase ไม่สำเร็จ: ${err.message || err}`;
          syncFirebaseBadge(false, "เชื่อมต่อไม่ได้");
          this.setStatus(this.firebaseLastError, "error");
        },
      );
    },
    async loadVehicleMappings() {
      if (!this.initFirebase()) return false;

      try {
        const snap = await firebaseDb.ref("vehicle_mappings").once("value");
        const map = {};

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

        this.vehicleMappings = map;
        return true;
      } catch (err) {
        console.error(err);
        this.setStatus(`อ่าน mapping รถไม่สำเร็จ: ${err.message || err}`, "warn");
        this.vehicleMappings = {};
        return false;
      }
    },

    async loadTrackedVehicleIds() {
      if (!this.initFirebase()) return [];

      // ลำดับเดิม: ใช้รายชื่อจาก vehicle_mappings ก่อน ถ้าว่างค่อยใช้ชื่อ node ใน locations
      // (ตอนนี้อ่านผ่าน shallow REST = ได้แค่ชื่อ key ไม่ดาวน์โหลดจุด GPS)
      const mappings = this.vehicleMappings || {};
      const ids = Object.keys(mappings).filter(Boolean);
      if (ids.length) {
        const listing = await FQ.listVehicleIds(firebaseDb, { mappings, skipLocations: true });
        const mappedIds = listing.mappingIds.slice();
        mappedIds.sort((a, b) => a.localeCompare(b, "th", { numeric: true, sensitivity: "base" }));
        return mappedIds;
      }

      try {
        const listing = await FQ.listVehicleIds(firebaseDb, { mappings });
        if (listing.shallowError) throw listing.shallowError;
        const fallbackIds = listing.locationIds.slice();

        fallbackIds.sort((a, b) => a.localeCompare(b, "th", { numeric: true, sensitivity: "base" }));
        this.setStatus(
          "ไม่พบ vehicle_mappings จึงต้องอ่านรายชื่อรถจาก locations แบบครั้งเดียว",
          "warn",
        );
        return fallbackIds;
      } catch (err) {
        console.error(err);
        this.setStatus(`อ่านรายชื่อรถไม่สำเร็จ: ${err.message || err}`, "error");
        return [];
      }
    },

    displayVehicleText(vehicleId) {
      const id = String(vehicleId || "").trim();
      if (!id) return "-";

      const plate = this.vehicleMappings?.[id]?.plate || "";
      return plate ? `${id} → ${plate}` : id;
    },

    initMap() {
      if (mapInstance) return;

      try {
        mapCanvasRenderer = L.canvas({ padding: 0.5 });
        mapInstance = L.map("map", {
          zoomControl: true,
          preferCanvas: true,
          updateWhenIdle: true,
        }).setView([13.736717, 100.523186], 6);

        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
          maxZoom: 19,
        }).addTo(mapInstance);

        this.mapReady = true;
        setTimeout(() => mapInstance.invalidateSize(), 100);
      } catch (err) {
        console.error(err);
        this.renderError = `สร้างแผนที่ไม่สำเร็จ: ${err.message || err}`;
        this.setStatus(this.renderError, "error");
      }
    },
    clearAllMapLayers() {
      if (!mapInstance) return;

      Object.keys(vehicleLayerStates).forEach((vehicleId) => {
        const state = vehicleLayerStates[vehicleId];
        if (state?.group) {
          try {
            state.group.remove();
          } catch (err) {
            console.warn(err);
          }
        }
      });

      vehicleLayerStates = Object.create(null);
      routeLayers.forEach((layer) => layer.remove());
      routeLayers = [];
      pointLayers.forEach((layer) => layer.remove());
      pointLayers = [];
    },
    removeVehicleLayer(vehicleId) {
      const state = vehicleLayerStates[vehicleId];
      if (!state) return;

      if (state.group) {
        try {
          state.group.remove();
        } catch (err) {
          console.warn(err);
        }
      }

      delete vehicleLayerStates[vehicleId];
    },
    createVehicleLayerState() {
      return {
        group: L.featureGroup(),
        points: [],
        lastPoint: null,
        tailPolyline: null,
        latestMarker: null,
      };
    },
    buildPointPopupContent(vehicle, point) {
      const timeStr = this.formatDateTime(point.timestampiso);
      const latStr = formatNum(point.lat, 6);
      const lngStr = formatNum(point.lng, 6);
      const speedStr = this.formatSpeed(point.speed);
      const accStr = this.formatAccuracy(point.accuracy);
      const distStr = point.segmentMeters != null ? `${point.segmentMeters.toFixed(2)} m` : "-";
      const cumulStr = point.cumulativeKm != null ? `${point.cumulativeKm.toFixed(2)} km` : "-";

      return `
        <div style="font-size: 12px; line-height: 1.4;">
          <strong>${vehicle.displayLabel || vehicle.vehicleId}</strong><br/>
          <strong>${timeStr}</strong><br/>
          Lat: ${latStr}<br/>
          Lng: ${lngStr}<br/>
          Speed: ${speedStr}<br/>
          ACC: ${accStr}<br/>
          ระยะจุดนี้: ${distStr}<br/>
          ระยะรวม: ${cumulStr}
        </div>
      `;
    },
    pointsHaveSamePrefix(oldPoints, newPoints) {
      if (!oldPoints || !newPoints) return false;
      if (oldPoints.length > newPoints.length) return false;
      if (oldPoints.length === 0) return true;
      if (oldPoints === newPoints) return true;

      // cache ของจุดมีแต่การ "เพิ่ม" (ไม่มีการลบ) ถ้ามีจุดแทรกกลางชุด จุดสุดท้ายของชุดเก่าจะถูกเลื่อน index
      // จึงตรวจแค่จุดแรกและจุดสุดท้ายของชุดเก่าก็พอ (O(1) แทน O(n) ทุกครั้งที่ render)
      const last = oldPoints.length - 1;
      return (
        pointKeyOf(oldPoints[0]) === pointKeyOf(newPoints[0]) &&
        pointKeyOf(oldPoints[last]) === pointKeyOf(newPoints[last])
      );
    },
    addPointDot(state, vehicle, point) {
      const marker = L.circleMarker([point.lat, point.lng], {
        radius: 4,
        color: vehicle.color,
        fillColor: vehicle.color,
        fillOpacity: 0.7,
        weight: 0.5,
        opacity: 0.7,
        renderer: mapCanvasRenderer,
        interactive: false,
      }).addTo(state.group);

      pointLayers.push(marker);
      return marker;
    },
    addPolylineSegment(state, vehicle, pointA, pointB) {
      const polyline = L.polyline(
        [
          [pointA.lat, pointA.lng],
          [pointB.lat, pointB.lng],
        ],
        {
          color: vehicle.color,
          weight: 2,
          opacity: 0.7,
          renderer: mapCanvasRenderer,
          interactive: false,
        },
      ).addTo(state.group);

      routeLayers.push(polyline);
      state.tailPolyline = polyline;
      return polyline;
    },
    appendPointToState(state, vehicle, point) {
      this.addPointDot(state, vehicle, point);

      if (state.lastPoint && state.lastPoint.date && point.date) {
        const gapMs = point.date.getTime() - state.lastPoint.date.getTime();
        if (gapMs > this.gapThresholdMs) {
          state.tailPolyline = null;
        } else if (!state.tailPolyline || state.tailPolyline.getLatLngs().length >= POLYLINE_CHUNK_POINTS) {
          // เริ่มเส้นท่อนใหม่ต่อจากจุดเดิม (ภาพเหมือนเดิม) เพื่อให้ canvas วาดใหม่เฉพาะท่อนท้าย ไม่ใช่ทั้งเส้นทางของวัน
          this.addPolylineSegment(state, vehicle, state.lastPoint, point);
        } else {
          state.tailPolyline.addLatLng([point.lat, point.lng]);
        }
      }

      state.lastPoint = point;
    },
    // วาดทั้งชุดใหม่: ผลเหมือนเรียก appendPointToState ทีละจุด แต่สร้าง polyline ทีเดียวต่อช่วง
    // (addLatLng ทีละจุดบนเส้นที่อยู่บนแผนที่แล้วเป็น O(n²) เพราะ Leaflet project ทั้งเส้นใหม่ทุกครั้ง)
    rebuildVehicleLayer(state, vehicle, points) {
      let run = [];
      const flushRun = () => {
        if (run.length >= 2) {
          const polyline = L.polyline(
            run.map((p) => [p.lat, p.lng]),
            {
              color: vehicle.color,
              weight: 2,
              opacity: 0.7,
              renderer: mapCanvasRenderer,
              interactive: false,
            },
          ).addTo(state.group);
          routeLayers.push(polyline);
          state.tailPolyline = polyline;
        } else {
          state.tailPolyline = null;
        }
      };

      points.forEach((point) => {
        this.addPointDot(state, vehicle, point);
        const prev = state.lastPoint;
        if (prev && prev.date && point.date) {
          const gapMs = point.date.getTime() - prev.date.getTime();
          if (gapMs > this.gapThresholdMs) {
            flushRun();
            run = [point];
          } else {
            if (!run.length) run.push(prev);
            if (run.length >= POLYLINE_CHUNK_POINTS) {
              flushRun();
              run = [prev];
            }
            run.push(point);
          }
        } else if (!prev) {
          run = [point];
        }
        state.lastPoint = point;
      });
      flushRun();
    },
    updateLatestMarker(state, vehicle, latest) {
      // จุดล่าสุดไม่เปลี่ยน → ไม่ต้องลบ/สร้าง marker ใหม่ (ลดพื้นที่ที่ canvas ต้องวาดใหม่ เหลือเฉพาะคันที่มีจุดใหม่)
      if (latest && state.latestMarker && state.latestMarkerColor === vehicle.color) {
        const html = this.buildPointPopupContent(vehicle, latest);
        if (state.latestMarkerKey === pointKeyOf(latest) && state.latestMarkerHtml === html) return;
        state.latestMarker.setLatLng([latest.lat, latest.lng]);
        state.latestMarker.setPopupContent(html);
        try {
          state.latestMarker.bringToFront();
        } catch (err) {
          console.warn(err);
        }
        state.latestMarkerKey = pointKeyOf(latest);
        state.latestMarkerHtml = html;
        return;
      }

      if (state.latestMarker) {
        try {
          state.latestMarker.remove();
        } catch (err) {
          console.warn(err);
        }
        state.latestMarker = null;
      }

      if (!latest) return;

      const latestMarker = L.circleMarker([latest.lat, latest.lng], {
        radius: 9,
        color: vehicle.color,
        fillColor: vehicle.color,
        fillOpacity: 1,
        weight: 1,
        opacity: 1,
        renderer: mapCanvasRenderer,
        interactive: true,
      })
        .addTo(state.group)
        .bindPopup(this.buildPointPopupContent(vehicle, latest), {
          autoPan: true,
          closeButton: true,
        });

      latestMarker.on("click", () => {
        try {
          latestMarker.openPopup();
        } catch (err) {
          console.warn(err);
        }
      });

      try {
        latestMarker.bringToFront();
      } catch (err) {
        console.warn(err);
      }

      state.latestMarker = latestMarker;
      state.latestMarkerKey = pointKeyOf(latest);
      state.latestMarkerHtml = latestMarker.getPopup() ? latestMarker.getPopup().getContent() : "";
      state.latestMarkerColor = vehicle.color;
    },
    syncVehicleLayer(vehicle) {
      if (!mapInstance) this.initMap();

      const vehicleId = vehicle.vehicleId;
      const nextPoints = vehicle.points || [];
      let state = vehicleLayerStates[vehicleId];

      if (!state) {
        state = vehicleLayerStates[vehicleId] = this.createVehicleLayerState();
        // เดิม group ถูกเพิ่มลงแผนที่ใน render รอบที่ 2 (ซึ่งเกิดจากการ replay child_added ทั้งประวัติ)
        // ตอนนี้ไม่มีการ replay แล้ว จึงต้องเพิ่มลงแผนที่ตั้งแต่สร้าง ไม่งั้นรถที่ยังไม่มีจุดใหม่จะไม่ถูกวาด
        state.group.addTo(mapInstance);
      } else if (state.group && !mapInstance.hasLayer(state.group)) {
        state.group.addTo(mapInstance);
      }

      const needsRebuild =
        !this.pointsHaveSamePrefix(state.points, nextPoints) ||
        nextPoints.length < state.points.length;

      if (needsRebuild) {
        try {
          state.group.clearLayers();
        } catch (err) {
          console.warn(err);
        }
        state.lastPoint = null;
        state.tailPolyline = null;
        state.latestMarker = null;

        this.rebuildVehicleLayer(state, vehicle, nextPoints);
      } else {
        for (let i = state.points.length; i < nextPoints.length; i += 1) {
          this.appendPointToState(state, vehicle, nextPoints[i]);
        }
      }

      // array ของจุดไม่ถูกแก้ไขภายหลัง (มีจุดใหม่ = array ใหม่) จึงเก็บ reference ได้ ไม่ต้อง copy
      state.points = nextPoints;
      this.updateLatestMarker(state, vehicle, nextPoints[nextPoints.length - 1] || null);

      return state;
    },
    renderLiveMap({ fitBounds = false } = {}) {
      try {
        this.renderError = "";
        if (!mapInstance) this.initMap();

        const summaries = this.visibleVehicleSummaries;
        const activeIds = new Set(summaries.map((v) => v.vehicleId));

        Object.keys(vehicleLayerStates).forEach((vehicleId) => {
          if (!activeIds.has(vehicleId)) {
            this.removeVehicleLayer(vehicleId);
          }
        });

        summaries.forEach((vehicle) => {
          this.syncVehicleLayer(vehicle);
        });

        if (fitBounds && !this.initialAutoFitDone) {
          this.fitToRoute();
          this.initialAutoFitDone = true;
        }
      } catch (err) {
        console.error(err);
        this.renderError = `แผนที่แสดงผลไม่สำเร็จ: ${err.message || err}`;
        this.setStatus(this.renderError, "error");
      } finally {
        this.refreshHealthState();
      }
    },
    buildSegments(points) {
      const pts = points || [];
      if (!pts.length) return [];

      const segments = [];
      let current = [pts[0]];

      for (let i = 1; i < pts.length; i += 1) {
        const prev = pts[i - 1];
        const curr = pts[i];
        const prevTime = prev.date ? prev.date.getTime() : null;
        const currTime = curr.date ? curr.date.getTime() : null;
        const isGap =
          prevTime !== null &&
          currTime !== null &&
          currTime - prevTime > this.gapThresholdMs;

        if (isGap) {
          if (current.length) segments.push(current);
          current = [curr];
        } else {
          current.push(curr);
        }
      }

      if (current.length) segments.push(current);
      return segments;
    },
    distanceKmFromSegments(segments) {
      if (!segments || !segments.length) return 0;
      let sum = 0;
      for (const seg of segments) {
        if (seg.length < 2) continue;
        for (let i = 1; i < seg.length; i += 1) {
          sum += haversineMeters(seg[i - 1].lat, seg[i - 1].lng, seg[i].lat, seg[i].lng);
        }
      }
      return sum / 1000;
    },

    simplifyPointsForRender(points, maxPoints = 200) {
      const pts = points || [];
      if (pts.length <= maxPoints) return pts;

      const first = pts[0];
      const last = pts[pts.length - 1];
      const innerTarget = Math.max(0, maxPoints - 2);
      const step = Math.max(1, Math.ceil((pts.length - 2) / innerTarget));

      const sampled = [first];
      for (let i = 1; i < pts.length - 1; i += step) {
        sampled.push(pts[i]);
      }

      if (sampled[sampled.length - 1] !== last) sampled.push(last);
      return sampled;
    },
    ensureRouteCacheDate() {
      const todayKey = localDateKey(new Date());
      if (this.routeCacheDateKey !== todayKey) {
        // ✅ วันเปลี่ยน: ล้าง cache เก่า และ lastKey เก่า
        this.routeCacheDateKey = todayKey;
        routePointCache = Object.create(null);
        routeKeySets = Object.create(null);
        routeCacheDirty = new Set();
        vehicleLastKey = Object.create(null);
        clearOldCaches(new Date());
      }
      return todayKey;
    },
    loadRouteCacheForVehicle(vehicleId) {
      this.ensureRouteCacheDate();
      return readRouteCache(vehicleId, new Date());
    },
    setRouteCacheForVehicle(vehicleId, points) {
      this.ensureRouteCacheDate();
      const normalized = markRaw(this.normalizeRoutePoints(points));
      routePointCache[vehicleId] = normalized;
      routeKeySets[vehicleId] = new Set(normalized.map(pointKeyOf));

      // ✅ ใหม่: บันทึก lastKey ของ vehicle นี้
      if (normalized.length > 0) {
        const lastPoint = normalized[normalized.length - 1];
        vehicleLastKey[vehicleId] = lastPoint.key || lastPoint.timestampiso;
      }
      this.markRouteCacheDirty(vehicleId);

      return normalized;
    },
    // เขียน localStorage แบบหน่วงเวลา (≤ 1 ครั้ง/10 วิ) + flush ตอน pagehide / แท็บถูกซ่อน
    markRouteCacheDirty(vehicleId) {
      routeCacheDirty.add(vehicleId);
      if (routeCacheTimer) return;
      routeCacheTimer = setTimeout(() => {
        routeCacheTimer = null;
        this.flushRouteCacheWrites();
      }, ROUTE_CACHE_WRITE_INTERVAL_MS);
    },
    flushRouteCacheWrites() {
      if (routeCacheTimer) {
        clearTimeout(routeCacheTimer);
        routeCacheTimer = null;
      }
      if (!routeCacheDirty.size) return;
      const ids = Array.from(routeCacheDirty);
      routeCacheDirty = new Set();
      // วันเปลี่ยนไปแล้ว ไม่เขียนข้อมูลของเมื่อวานลง key ของวันนี้
      if (this.routeCacheDateKey !== localDateKey(new Date())) return;

      const now = new Date();
      ids.forEach((vehicleId) => {
        const points = routePointCache[vehicleId] || [];
        if (!points.length) return;
        writeRouteCache(vehicleId, points, now);
        const lastPoint = points[points.length - 1];
        writeLastKeyCache(vehicleId, lastPoint.key || lastPoint.timestampiso, now);
      });
    },
    normalizeRoutePoints(points) {
      const list = Array.isArray(points) ? points : [];
      const normalized = list
        .map((point) => {
          if (!point) return null;
          const lat = Number(point.lat);
          const lng = Number(point.lng);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

          const timestampiso = String(point.timestampiso || point.key || '');
          const date = point.date instanceof Date ? point.date : toDateSafe(timestampiso);
          if (!date) return null;

          return {
            ...point,
            key: point.key || timestampiso,
            lat,
            lng,
            speed: Number.isFinite(Number(point.speed)) ? Number(point.speed) : null,
            accuracy: Number.isFinite(Number(point.accuracy)) ? Number(point.accuracy) : null,
            timestampiso,
            date,
            raw: null, // ไม่เก็บ raw ของ Firebase ใน cache (ไม่มีที่ใช้ และกินหน่วยความจำ)
            pointNo: 0,
            segmentMeters: 0,
            cumulativeMeters: 0,
            cumulativeKm: 0,
          };
        })
        .filter(Boolean)
        .sort((a, b) => {
          const ta = a.date ? a.date.getTime() : 0;
          const tb = b.date ? b.date.getTime() : 0;
          return ta - tb;
        });

      return recomputeRouteMetrics(normalized, 0);
    },

    // ✅ ใหม่: ดึงเฉพาะข้อมูลใหม่หลัง lastKey (incremental sync)
    async fetchIncrementalRouteForVehicle(vehicleId, afterKey = null) {
      if (!this.initFirebase()) return [];

      try {
        // ถ้ามี lastKey แล้ว ให้ดึงเฉพาะข้อมูลใหม่หลังจากนั้น
        // ถ้าไม่มี cache เลย ให้โหลดเฉพาะวันนี้ทั้งวันครั้งเดียว
        const todayKey = localDateKey(new Date());
        const snap = afterKey
          ? await FQ.fetchAfter(firebaseDb, vehicleId, afterKey)
          : await FQ.fetchRange(firebaseDb, vehicleId, todayKey, todayKey);
        return this.parseVehicleSnapshot(snap, afterKey);
      } catch (err) {
        console.error(err);
        this.setStatus(`ดึงข้อมูลของรถ ${vehicleId} ไม่สำเร็จ: ${err.message || err}`, 'warn');
        return [];
      }
    },

    async fetchTodayRouteForVehicle(vehicleId) {
      if (!this.initFirebase()) return [];

      try {
        const todayKey = localDateKey(new Date());
        const snap = await FQ.fetchRange(firebaseDb, vehicleId, todayKey, todayKey);

        const points = this.parseVehicleSnapshot(snap);
        if (points.length) {
          this.setRouteCacheForVehicle(vehicleId, points);
        }
        return points;
      } catch (err) {
        console.error(err);
        this.setStatus(`ดึงข้อมูลวันนี้ของรถ ${vehicleId} ไม่สำเร็จ: ${err.message || err}`, 'warn');
        return [];
      }
    },
    parseVehicleSnapshot(vehicleSnapshot, skipKey = null) {
      const points = [];

      vehicleSnapshot.forEach((child) => {
        if (skipKey && child.key === skipKey) return; // startAt เป็น inclusive: ข้าม cursor
        const point = this.buildPointFromRaw(child.key, child.val() || {});
        if (point) points.push(point);
      });

      points.sort((a, b) => {
        const ta = a.date ? a.date.getTime() : 0;
        const tb = b.date ? b.date.getTime() : 0;
        return ta - tb;
      });

      return recomputeRouteMetrics(points, 0);
    },
    detachLiveListener() {
      Object.keys(liveDetachers).forEach((vehicleId) => {
        try {
          liveDetachers[vehicleId]();
        } catch (err) {
          console.warn(err);
        }
      });
      liveDetachers = Object.create(null);

      Object.entries(vehicleLiveRefs).forEach(([vehicleId, ref]) => {
        const entry = vehicleLiveCallbacks[vehicleId];
        if (!ref || !entry) return;

        try {
          ref.off(entry.type || "value", entry.callback);
        } catch (err) {
          console.warn(err);
        }
      });

      vehicleLiveRefs = Object.create(null);
      vehicleLiveCallbacks = Object.create(null);
      this.stopPeriodicSync();

      if (firebaseInfoRef && firebaseInfoCallback) {
        try {
          firebaseInfoRef.off("value", firebaseInfoCallback);
        } catch (err) {
          console.warn(err);
        }
      }
      firebaseInfoRef = null;
      firebaseInfoCallback = null;
    },
    // ติดตาม .info/connected ไว้ใช้ตัดสินใจข้าม resync ตอนออฟไลน์ (ไม่เปลี่ยนการแสดงผลเดิม)
    watchRtdbConnection() {
      if (rtdbConnectedRef || !firebaseDb) return;
      rtdbConnectedRef = firebaseDb.ref(".info/connected");
      rtdbConnectedCallback = (snapshot) => {
        rtdbConnected = !!snapshot.val();
      };
      rtdbConnectedRef.on("value", rtdbConnectedCallback, () => {
        rtdbConnected = null;
      });
    },
    unwatchRtdbConnection() {
      if (rtdbConnectedRef && rtdbConnectedCallback) {
        try {
          rtdbConnectedRef.off("value", rtdbConnectedCallback);
        } catch (err) {
          console.warn(err);
        }
      }
      rtdbConnectedRef = null;
      rtdbConnectedCallback = null;
    },
    isOffline() {
      if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
      return rtdbConnected === false;
    },
    startHealthMonitor() {
      this.stopHealthMonitor();
      this.healthTimer = setInterval(() => {
        this.healthPulse += 1;
        if (this.checkDayChanged()) return;
        this.refreshHealthState(true);
      }, 30000);
    },
    stopHealthMonitor() {
      if (this.healthTimer) {
        clearInterval(this.healthTimer);
        this.healthTimer = null;
      }
    },
    // ข้ามเที่ยงคืน: เริ่ม subscribe ใหม่จากต้นวันใหม่ (ล้าง cache ของเมื่อวาน)
    checkDayChanged() {
      if (this.routeCacheDateKey === localDateKey(new Date())) return false;
      if (!this.dayChangePending) {
        this.dayChangePending = true;
        Promise.resolve(this.subscribeTodayLive()).finally(() => {
          this.dayChangePending = false;
        });
      }
      return true;
    },
    // รวมชุดข้อมูลใหม่ (จาก server หรือ live event) เข้ากับ cache เดิม โดยอ้างอิง key/timestamp
    // ห้าม replace ทั้งชุด เพื่อไม่ให้จุดที่เคยมีอยู่แล้วหายไปเวลาข้อมูลใหม่มาไม่ครบ
    // คืน array เดิม (reference เดิม) ถ้าไม่มีจุดใหม่จริง
    mergePointsIntoCache(vehicleId, incomingPoints) {
      const current = routePointCache[vehicleId] || [];
      let keys = routeKeySets[vehicleId];
      if (!keys) {
        keys = new Set(current.map(pointKeyOf));
        routeKeySets[vehicleId] = keys;
      }

      const seen = new Set();
      const fresh = [];
      (incomingPoints || []).forEach((p) => {
        if (!p) return;
        const k = pointKeyOf(p);
        if (keys.has(k) || seen.has(k)) return;
        seen.add(k);
        fresh.push(p);
      });
      if (!fresh.length) return current;

      const freshNormalized = this.normalizeRoutePoints(fresh);
      if (!freshNormalized.length) return current;

      const lastCurrent = current[current.length - 1];
      const lastTime = lastCurrent && lastCurrent.date ? lastCurrent.date.getTime() : -Infinity;
      let merged;
      if (freshNormalized[0].date.getTime() >= lastTime) {
        // กรณีปกติ: จุดใหม่ต่อท้าย ไม่ต้อง normalize/sort ทั้งชุด
        merged = current.concat(freshNormalized);
        recomputeRouteMetrics(merged, current.length);
      } else {
        // จุดมาไม่เรียงเวลา: เรียงใหม่ทั้งชุด (ตรรกะเดิม)
        merged = this.normalizeRoutePoints(current.concat(freshNormalized));
      }

      freshNormalized.forEach((p) => keys.add(pointKeyOf(p)));
      merged = markRaw(merged);
      routePointCache[vehicleId] = merged;

      // ✅ ใหม่: อัปเดต lastKey หลังจาก merge
      const lastPoint = merged[merged.length - 1];
      vehicleLastKey[vehicleId] = lastPoint.key || lastPoint.timestampiso;
      this.markRouteCacheDirty(vehicleId);

      return merged;
    },

    buildPointFromRaw(key, value) {
      const lat = Number(value.lat);
      const lng = Number(value.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

      const timestampiso = String(value.timestampiso || key || "");
      const date = toDateSafe(timestampiso);
      if (!date) return null;

      const { start, end } = getTodayBounds();
      if (date < start || date > end) return null;

      return {
        key,
        lat,
        lng,
        speed: Number.isFinite(Number(value.speed_kmh))
          ? Number(value.speed_kmh)
          : Number.isFinite(Number(value.speed))
            ? Number(value.speed)
            : null,
        accuracy: Number.isFinite(Number(value.accuracy)) ? Number(value.accuracy) : null,
        timestampiso,
        date,
        raw: null, // ไม่เก็บ raw ของ Firebase ใน cache
        pointNo: 0,
        segmentMeters: 0,
        cumulativeMeters: 0,
        cumulativeKm: 0,
      };
    },

    setVehicleResult(result, vehicleId, merged) {
      const latest = merged[merged.length - 1] || null;
      result[vehicleId] = {
        points: merged,
        lastSeenAt: latest?.date ? latest.date.toISOString() : new Date().toISOString(),
      };
    },

    // ✅ ใหม่: Sync ข้อมูลใหม่หลัง lastKey (incremental)
    async syncVehicleFromServerIncremental(vehicleId, result, session = liveSessionId) {
      const lastKey = vehicleLastKey[vehicleId] || null;

      // ถ้ามี lastKey แล้ว ให้ดึงเฉพาะข้อมูลใหม่ (ข้าม key == lastKey)
      // ถ้าไม่มี lastKey เลย ให้โหลดวันนี้ทั้งวันครั้งเดียว
      const points = await this.fetchIncrementalRouteForVehicle(vehicleId, lastKey);
      if (session !== liveSessionId) return;
      if (!points.length) return;

      const before = routePointCache[vehicleId];
      const merged = this.mergePointsIntoCache(vehicleId, points);
      if (merged === before && result[vehicleId]) return;
      this.setVehicleResult(result, vehicleId, merged);
    },

    attachChildAddedListener(vehicleId, result) {
      // เริ่มฟังจาก key ล่าสุดที่ sync แล้วเสมอ (ไม่ replay ประวัติทั้งหมด) ถ้ายังไม่มีให้เริ่มที่ต้นวันนี้
      const startKey = vehicleLastKey[vehicleId] || getTodayKeyRange().startKey;
      const session = liveSessionId;

      const callback = (snapshot) => {
        if (session !== liveSessionId) return;
        if (this.checkDayChanged()) return;

        const point = this.buildPointFromRaw(snapshot.key, snapshot.val() || {});
        if (!point) return;

        // ✅ ป้องกัน duplicate ด้วย Set ของ key (O(1))
        const before = routePointCache[vehicleId];
        const merged = this.mergePointsIntoCache(vehicleId, [point]);
        if (merged === before) return; // ข้อมูลนี้มีแล้ว ไม่ต้องเพิ่ม

        this.setVehicleResult(result, vehicleId, merged);
        this.scheduleRenderRoute({ commit: true });
      };

      const errorHandler = (err) => {
        console.error(err);
        this.firebaseLastError = `subscribe รถ ${vehicleId} ไม่สำเร็จ: ${err.message || err}`;
        this.setStatus(this.firebaseLastError, "error");
        this.refreshHealthState();
      };

      liveDetachers[vehicleId] = FQ.listenAfter(firebaseDb, vehicleId, startKey, callback, errorHandler);
    },

    // ✅ ใหม่: Periodic Sync ดึงเฉพาะข้อมูลใหม่หลัง lastKey
    startPeriodicSync(trackedIds, result) {
      this.stopPeriodicSync();

      periodicSyncTimer = setInterval(() => {
        this.runPeriodicResync(trackedIds, result);
      }, PERIODIC_RESYNC_MS);

      visibilityChangeHandler = () => {
        if (document.visibilityState === "visible") {
          this.runPeriodicResync(trackedIds, result);
        } else {
          this.flushRouteCacheWrites();
        }
      };
      document.addEventListener("visibilitychange", visibilityChangeHandler);
    },

    stopPeriodicSync() {
      if (periodicSyncTimer) {
        clearInterval(periodicSyncTimer);
        periodicSyncTimer = null;
      }
      if (visibilityChangeHandler) {
        document.removeEventListener("visibilitychange", visibilityChangeHandler);
        visibilityChangeHandler = null;
      }
    },

    async runPeriodicResync(trackedIds, result) {
      if (!firebaseDb) return;
      // ข้ามเมื่อแท็บซ่อน / ออฟไลน์ / รอบก่อนยังไม่เสร็จ
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (this.isOffline()) return;
      if (resyncInFlight) return;
      if (this.checkDayChanged()) return;

      const session = liveSessionId;
      let changed = false;
      resyncInFlight = true;

      try {
        await Promise.allSettled(
          trackedIds.map(async (vehicleId) => {
            // ✅ ดึงเฉพาะข้อมูลใหม่หลัง lastKey เท่านั้น (ถ้ายังไม่มี เริ่มที่ต้นวันนี้)
            const cursorKey = vehicleLastKey[vehicleId] || getTodayKeyRange().startKey;
            try {
              const snap = await FQ.fetchAfter(firebaseDb, vehicleId, cursorKey);
              if (session !== liveSessionId) return;

              const raw = [];
              snap.forEach((child) => {
                if (child.key === cursorKey) return;
                const point = this.buildPointFromRaw(child.key, child.val() || {});
                if (point) raw.push(point);
              });
              if (!raw.length) return;

              const before = routePointCache[vehicleId];
              const merged = this.mergePointsIntoCache(vehicleId, raw);
              if (merged === before) return;

              this.setVehicleResult(result, vehicleId, merged);
              changed = true;
            } catch (err) {
              console.warn(`periodic resync failed for ${vehicleId}`, err);
            }
          }),
        );
      } finally {
        resyncInFlight = false;
      }

      if (session !== liveSessionId) return;
      this.lastRefreshAt = new Date().toISOString();
      // อัปเดต vehiclesById เฉพาะเมื่อมีจุดใหม่จริง
      if (changed) this.scheduleRenderRoute({ commit: true });
      this.refreshHealthState(true);
    },

    async subscribeTodayLive() {
      if (!this.initFirebase()) return;

      liveSessionId += 1;
      const session = liveSessionId;
      // ให้ cursor จาก localStorage เป็นปัจจุบันที่สุดก่อนเริ่มรอบใหม่
      this.flushRouteCacheWrites();

      this.subscribeFirebaseConnectionState();
      this.watchRtdbConnection();
      await this.loadVehicleMappings();
      if (session !== liveSessionId) return;

      const trackedIds = await this.loadTrackedVehicleIds();
      if (session !== liveSessionId) return;

      this.loading = true;
      this.firebaseLastError = "";
      this.setStatus("กำลังโหลดรถวิ่งล่าสุด...", "info");
      this.detachLiveListener();
      this.ensureRouteCacheDate();
      routePointCache = Object.create(null);
      routeKeySets = Object.create(null);
      vehicleLastKey = Object.create(null);

      if (!trackedIds.length) {
        liveResult = null;
        this.vehiclesById = {};
        this.loading = false;
        this.updateNoDataState(0);
        this.refreshHealthState(true);
        return;
      }

      const result = {};
      liveResult = result;

      // 1) แสดงผลจาก cache (localStorage) ก่อนแบบชั่วคราว เพื่อไม่ให้หน้าจอว่างระหว่างรอ sync จริง
      trackedIds.forEach((vehicleId) => {
        const cached = this.loadRouteCacheForVehicle(vehicleId);
        if (!cached.length) return;

        const points = markRaw(cached);
        routePointCache[vehicleId] = points;
        routeKeySets[vehicleId] = new Set(points.map(pointKeyOf));
        this.setVehicleResult(result, vehicleId, points);
        // ✅ ใหม่: โหลด lastKey จาก localStorage
        const latest = points[points.length - 1];
        vehicleLastKey[vehicleId] = latest?.key || null;
      });

      if (Object.keys(result).length) {
        this.vehiclesById = { ...result };
        this.scheduleRenderRoute({ fitBounds: !this.initialAutoFitDone, immediate: true });
        this.setStatus("แสดงข้อมูลจาก cache ชั่วคราว กำลังซิงก์กับ Firebase...", "info");
      }

      // 2) ✅ ใหม่: Sync ข้อมูลใหม่หลัง lastKey (incremental) แทนการโหลดทั้งวัน
      await Promise.allSettled(
        trackedIds.map((vehicleId) => this.syncVehicleFromServerIncremental(vehicleId, result, session)),
      );
      if (session !== liveSessionId) return;

      this.vehiclesById = { ...result };
      this.lastRefreshAt = new Date().toISOString();
      this.scheduleRenderRoute({ fitBounds: !this.initialAutoFitDone, immediate: true });
      this.loading = false;

      const countAfterInitialLoad = Object.keys(result).length;
      if (countAfterInitialLoad) {
        this.noDataToday = false;
        this.noDataCheckedAt = new Date().toISOString();
        this.noDataNotifiedFor = "";
      } else {
        this.updateNoDataState(0);
      }

      // 3) ผูก child_added ต่อจาก key ล่าสุดที่ sync แล้ว สำหรับรับข้อมูลใหม่แบบ realtime
      trackedIds.forEach((vehicleId) => {
        this.attachChildAddedListener(vehicleId, result);
      });

      // 4) Sync สำรองเป็นระยะ + ตอนกลับมาที่แท็บ เผื่อ listener หลุด/บราวเซอร์ throttle หน้าที่พักไว้นาน
      this.startPeriodicSync(trackedIds, result);
    },

    toggleAllVehicles(show) {
      this.vehicleSummaries.forEach((v) => {
        this.visibleVehicles[v.vehicleId] = show;
      });
      this.scheduleRenderRoute();
    },
    // รวมการอัปเดตให้ commit vehiclesById + render แผนที่ ไม่เกิน 1 ครั้ง/วินาที
    // opts.commit = มีจุดใหม่ใน liveResult ที่ต้อง commit เข้า vehiclesById
    // opts.immediate = render รอบนี้ทันที (โหลดครั้งแรก/กดปุ่ม)
    scheduleRenderRoute({ fitBounds = false, commit = false, immediate = false } = {}) {
      this.renderNeedsFit = this.renderNeedsFit || fitBounds;
      this.renderNeedsCommit = this.renderNeedsCommit || commit;

      if (this.renderTimer) {
        if (!immediate) return;
        clearTimeout(this.renderTimer);
      }

      const wait = immediate ? 0 : Math.max(0, RENDER_MIN_INTERVAL_MS - (Date.now() - renderLastAt));
      this.renderPending = true;
      this.renderTimer = setTimeout(() => {
        this.renderTimer = null;
        this.renderPending = false;
        renderLastAt = Date.now();
        const committed = this.renderNeedsCommit && !!liveResult;
        if (committed) {
          this.vehiclesById = { ...liveResult };
        }
        this.renderNeedsCommit = false;
        const doFit = this.renderNeedsFit;
        this.renderNeedsFit = false;
        this.renderLiveMap({ fitBounds: doFit });
        if (committed) this.refreshHealthState(true);
      }, wait);
    },

    fitToRoute() {
      if (!mapInstance || !this.visiblePointCount) return;
      const bounds = L.latLngBounds([]);
      this.visibleVehicleSummaries.forEach((vehicle) => {
        vehicle.points.forEach((p) => bounds.extend([p.lat, p.lng]));
      });
      if (bounds.isValid()) mapInstance.fitBounds(bounds.pad(0.15));
    },
    focusPoint(row) {
      if (!row || !mapInstance) return;
      mapInstance.setView([row.lat, row.lng], Math.max(mapInstance.getZoom(), 16));
      const popup = L.popup()
        .setLatLng([row.lat, row.lng])
        .setContent(
          `<strong>${row.displayLabel || row.vehicleId}</strong><br/><strong>${this.formatDateTime(
            row.timestampiso,
          )}</strong><br/>Lat: ${formatNum(row.lat, 6)}<br/>Lng: ${formatNum(
            row.lng,
            6,
          )}<br/>Speed: ${this.formatSpeed(row.speed)}<br/>ACC: ${this.formatAccuracy(row.accuracy)}<br/>ระยะจุดนี้: ${row.segmentMeters != null ? row.segmentMeters.toFixed(2) : "-"
          } m<br/>ระยะรวม: ${row.cumulativeKm != null ? row.cumulativeKm.toFixed(2) : "-"
          } km`,
        );
      popup.openOn(mapInstance);
    },
    resizeMap() {
      if (mapInstance) setTimeout(() => mapInstance.invalidateSize(), 50);
    },
  },
  mounted() {
    this.initMap();
    this.resizeHandler = () => this.resizeMap();
    window.addEventListener("resize", this.resizeHandler);
    pageHideHandler = () => this.flushRouteCacheWrites();
    window.addEventListener("pagehide", pageHideHandler);
    this.startHealthMonitor();
    this.subscribeTodayLive();
  },
  beforeUnmount() {
    this.flushRouteCacheWrites();
    if (pageHideHandler) window.removeEventListener("pagehide", pageHideHandler);
    pageHideHandler = null;
    liveSessionId += 1;
    this.stopHealthMonitor();
    this.detachLiveListener();
    this.detachFirebaseInfoListener();
    this.unwatchRtdbConnection();
    if (this.resizeHandler) window.removeEventListener("resize", this.resizeHandler);
    if (mapInstance) {
      mapInstance.remove();
      mapInstance = null;
    }
  },
}).mount("#app");
