const { createApp, markRaw } = Vue;
const FQ = window.FirebaseQueries;

let firebaseDb = null;
let firebaseInfoRef = null;
let firebaseInfoCallback = null;
let mapInstance = null;
let routeLayers = [];
let pointLayers = [];
let historyLayerGroup = null;

// ---- ดึงข้อมูลตามช่วงวันที่ + cache ในหน่วยความจำ ----
const HISTORY_TABLE_PAGE_SIZE = 200;
const RANGE_DEBOUNCE_MS = 400;
const CONFIRM_RANGE_DAYS = 7; // ช่วงเกิน 7 วัน ต้องยืนยันก่อนโหลด
const CONFIRM_ESTIMATED_POINTS = 20000; // คาดว่าเกิน 20,000 จุด ต้องยืนยันก่อนโหลด
// จำนวนจุดโดยประมาณต่อคันต่อวัน (ใช้ประเมินก่อนโหลดเท่านั้น) ปรับได้ด้วย window.FCGPS_POINTS_PER_DAY
const ESTIMATED_POINTS_PER_VEHICLE_PER_DAY = Number(window.FCGPS_POINTS_PER_DAY) > 0 ? Number(window.FCGPS_POINTS_PER_DAY) : 2880;
const OPEN_RANGE_CACHE_TTL_MS = 60000; // ช่วงที่รวมวันนี้ ใช้ cache ได้ไม่เกิน 60 วิ
const TRACK_CACHE_MAX_ENTRIES = 24;
const MAX_MARKERS_PER_TRACK = 5000; // เกินนี้ลดจำนวน marker (polyline ยังใช้จุดครบ)
// key = vehicleId|from|to -> { points, fetchedAt, open }
const trackCache = new Map();
let loadSeq = 0; // เลขลำดับ request กันผลเก่าทับผลใหม่
let rangeDebounceTimer = null;

function trackCacheKey(vehicleId, from, to) {
  return `${vehicleId}|${from}|${to}`;
}

function rememberTrack(key, entry) {
  trackCache.delete(key);
  trackCache.set(key, entry);
  while (trackCache.size > TRACK_CACHE_MAX_ENTRIES) {
    trackCache.delete(trackCache.keys().next().value);
  }
}

function getCachedTrack(key) {
  const entry = trackCache.get(key);
  if (!entry) return null;
  if (entry.open && Date.now() - entry.fetchedAt > OPEN_RANGE_CACHE_TTL_MS) return null;
  return entry;
}

function daysInRange(from, to) {
  const a = new Date(`${from}T00:00:00`);
  const b = new Date(`${to}T00:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 1;
  return Math.max(1, Math.round((b.getTime() - a.getTime()) / 86400000) + 1);
}

// pointNo / ระยะจุดนี้ / ระยะสะสมรายวัน (ตรรกะเดิมของ parseSnapshot)
function numberHistoryPoints(items) {
  items.forEach((p, idx) => {
    p.pointNo = idx + 1;
    if (idx === 0) {
      p.segmentMeters = 0;
      p.cumulativeMeters = 0;
    } else {
      const prev = items[idx - 1];
      const isNewDay = !isSameCalendarDay(prev.date, p.date);
      if (isNewDay) {
        p.segmentMeters = 0;
        p.cumulativeMeters = 0;
      } else {
        p.segmentMeters = haversineMeters(prev.lat, prev.lng, p.lat, p.lng);
        p.cumulativeMeters = (prev.cumulativeMeters || 0) + (p.segmentMeters || 0);
      }
    }
    p.cumulativeKm = (p.cumulativeMeters || 0) / 1000;
  });
  return items;
}

function todayISODate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function pad(n) {
  return String(Math.abs(Number(n) || 0)).padStart(2, "0");
}

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

function isSameCalendarDay(a, b) {
  if (!a || !b) return false;
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
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

function escapeCsv(value) {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function formatDateTime(value) {
  const d = toDateSafe(value);
  if (!d) return "-";
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDistanceKm(meters) {
  if (!Number.isFinite(meters)) return "-";
  return `${(meters / 1000).toFixed(2)} km`;
}

function syncFirebaseBadge(connected, message) {
  if (typeof window.setFirebaseNavStatus === "function") {
    window.setFirebaseNavStatus(connected, message);
  }
}

function isSuspiciousJump(prev, curr, maxSpeedKmh = 180) {
  if (!prev || !curr || !prev.date || !curr.date) return null;

  const timeMs = curr.date.getTime() - prev.date.getTime();
  if (!Number.isFinite(timeMs) || timeMs <= 0) {
    return { suspicious: true, reason: "เวลาไม่เรียงหรือซ้ำกับจุดก่อนหน้า" };
  }

  const distanceMeters = haversineMeters(prev.lat, prev.lng, curr.lat, curr.lng);
  const hours = timeMs / 3_600_000;
  const impliedSpeed = hours > 0 ? (distanceMeters / 1000) / hours : Infinity;

  if (!Number.isFinite(distanceMeters) || !Number.isFinite(impliedSpeed)) {
    return { suspicious: true, reason: "คำนวณระยะทางไม่ได้" };
  }

  if (impliedSpeed > maxSpeedKmh) {
    return {
      suspicious: true,
      reason: `กระโดด ${formatDistanceKm(distanceMeters)} ใน ${(
        timeMs / 60000
      ).toFixed(1)} นาที`,
    };
  }

  return null;
}

function colorForId(vehicleId) {
  const COLORS = [
    "#38bdf8",
    "#f59e0b",
    "#22c55e",
    "#a855f7",
    "#ef4444",
    "#14b8a6",
    "#eab308",
    "#f97316",
    "#06b6d4",
    "#8b5cf6",
    "#84cc16",
    "#ec4899",
  ];
  let hash = 0;
  for (let i = 0; i < vehicleId.length; i += 1) {
    hash = (hash * 31 + vehicleId.charCodeAt(i)) >>> 0;
  }
  return COLORS[hash % COLORS.length];
}


function initNavbar() {
  const toggle = document.querySelector("[data-nav-toggle]");
  const drawer = document.querySelector("[data-nav-drawer]");
  const backdrop = document.querySelector("[data-nav-backdrop]");
  const links = document.querySelectorAll(".site-nav__link");

  if (!toggle || !drawer || !backdrop) return;

  const page = (location.pathname.split("/").pop() || "index.html").toLowerCase();

  links.forEach((link) => {
    const href = (link.getAttribute("href") || "").toLowerCase();
    if (href === page) link.classList.add("is-active");
  });

  const setOpen = (open) => {
    drawer.classList.toggle("is-open", open);
    backdrop.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("nav-open", open);
  };

  toggle.addEventListener("click", () => {
    setOpen(!drawer.classList.contains("is-open"));
  });

  backdrop.addEventListener("click", () => setOpen(false));

  links.forEach((link) => {
    link.addEventListener("click", () => setOpen(false));
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setOpen(false);
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 980) setOpen(false);
  });
}


initNavbar();

createApp({
  data() {
    const today = todayISODate();

    return {
      deviceOptions: [],
      deviceLoading: false,
      vehicleMappings: {},

      vehicleId1: "",
      vehicleId2: "",
      vehicleId3: "",
      vehicleId4: "",

      fromDate: today,
      toDate: today,
      gapMinutesInput: "1",

      filterVehicle: "",
      filterHourSlot: "",

      showVehicle1: true,
      showVehicle2: true,
      showVehicle3: true,
      showVehicle4: true,

      tracks: {
        v1: {
          points: [],
          lastUpdatedAt: null,
          status: "ยังไม่ได้โหลด",
          statusType: "info",
        },
        v2: {
          points: [],
          lastUpdatedAt: null,
          status: "ยังไม่ได้โหลด",
          statusType: "info",
        },
        v3: {
          points: [],
          lastUpdatedAt: null,
          status: "ยังไม่ได้โหลด",
          statusType: "info",
        },
        v4: {
          points: [],
          lastUpdatedAt: null,
          status: "ยังไม่ได้โหลด",
          statusType: "info",
        },
      },

      loading: false,
      status: "พร้อมใช้งาน",
      statusType: "info",
      resizeHandler: null,
      tableLimit: HISTORY_TABLE_PAGE_SIZE,
    };
  },

  computed: {
    gapThresholdMinutes() {
      const n = Number(this.gapMinutesInput);
      return Number.isFinite(n) && n >= 0 ? n : 1;
    },

    gapThresholdMs() {
      return this.gapThresholdMinutes * 60 * 1000;
    },

    selectedDateRangeText() {
      return `${this.fromDate || "-"} ถึง ${this.toDate || "-"}`;
    },

    vehicleLabelMap() {
      return this.vehicleMappings || {};
    },

    vehicleConfigs() {
      const raw = [
        {
          slot: "v1",
          label: "คันที่ 1",
          vehicleId: this.vehicleId1,
          visible: this.showVehicle1,
        },
        {
          slot: "v2",
          label: "คันที่ 2",
          vehicleId: this.vehicleId2,
          visible: this.showVehicle2,
        },
        {
          slot: "v3",
          label: "คันที่ 3",
          vehicleId: this.vehicleId3,
          visible: this.showVehicle3,
        },
        {
          slot: "v4",
          label: "คันที่ 4",
          vehicleId: this.vehicleId4,
          visible: this.showVehicle4,
        },
      ];

      return raw.map((cfg) => {
        const id = String(cfg.vehicleId || "").trim();
        const plate = this.vehicleLabelMap[id]?.plate || "";
        return {
          ...cfg,
          vehicleId: id,
          plateText: plate,
          displayLabel: id ? (plate ? `${id} → ${plate}` : id) : "",
          color: id ? colorForId(id) : "#94a3b8",
        };
      });
    },

    trackSummaries() {
      return this.vehicleConfigs
        .filter((cfg) => cfg.vehicleId)
        .map((cfg) => {
          const rawPoints = this.tracks[cfg.slot]?.points || [];
          const filteredPoints = this.getFilteredPoints(rawPoints);
          const segments = this.buildSegments(filteredPoints);
          const distanceKm = this.distanceKmFromSegments(segments);
          const distanceKmDisplay = Number(distanceKm.toFixed(2));
          const latest = filteredPoints.length
            ? filteredPoints[filteredPoints.length - 1]
            : null;

          return {
            ...cfg,
            latest,
            pointCount: filteredPoints.length,
            segmentCount: segments.filter((s) => s.length >= 2).length,
            distanceKm: distanceKmDisplay,
            distanceText: `${distanceKmDisplay.toFixed(2)} km`,
            firstText: filteredPoints.length
              ? formatDateTime(filteredPoints[0].timestampiso)
              : "-",
            lastText: filteredPoints.length
              ? formatDateTime(
                filteredPoints[filteredPoints.length - 1].timestampiso,
              )
              : "-",
            lastUpdatedAt: this.tracks[cfg.slot]?.lastUpdatedAt || null,
            status: this.tracks[cfg.slot]?.status || "-",
            statusType: this.tracks[cfg.slot]?.statusType || "info",
            filteredPoints,
            segments,
          };
        });
    },

    visibleTrackSummaries() {
      return this.trackSummaries.filter((track) => track.visible);
    },

    visibleAllFilteredPoints() {
      const rows = [];

      for (const track of this.visibleTrackSummaries) {
        let rowsFromTrack = track.filteredPoints;

        if (this.filterVehicle && track.vehicleId !== this.filterVehicle) {
          continue;
        }

        if (this.filterHourSlot !== "") {
          const selectedHour = Number(this.filterHourSlot);
          rowsFromTrack = rowsFromTrack.filter(
            (p) => p.date && p.date.getHours() === selectedHour,
          );
        }

        rowsFromTrack.forEach((p, idx) => {
          rows.push({
            ...p,
            slot: track.slot,
            label: track.label,
            displayLabel: track.displayLabel || track.vehicleId,
            vehicleId: track.vehicleId,
            color: track.color,
            pointNo: p.pointNo ?? idx + 1,
            segmentMeters: p.segmentMeters ?? null,
            cumulativeMeters: p.cumulativeMeters ?? null,
            cumulativeKm: p.cumulativeKm ?? null,
            dailyDistanceKm: p.cumulativeKm ?? null,
            dailyDistanceText: p.cumulativeKm != null ? `${p.cumulativeKm.toFixed(2)} km` : '-',
          });
        });
      }

      rows.sort((a, b) => {
        const ta = a.date ? a.date.getTime() : 0;
        const tb = b.date ? b.date.getTime() : 0;
        return tb - ta;
      });

      return rows;
    },

    // ตารางแสดงทีละ 200 แถว (export CSV ยังใช้ visibleAllFilteredPoints ครบทุกแถว)
    pagedRows() {
      return this.visibleAllFilteredPoints.slice(0, this.tableLimit);
    },

    latestVisiblePoint() {
      return this.visibleAllFilteredPoints.length ? this.visibleAllFilteredPoints[0] : null;
    },

    totalDistanceText() {
      return this.latestVisiblePoint && this.latestVisiblePoint.cumulativeKm != null
        ? `${this.latestVisiblePoint.cumulativeKm.toFixed(2)} km`
        : '-';
    },

    lastUpdatedText() {
      const times = this.visibleTrackSummaries
        .map((t) => t.lastUpdatedAt)
        .filter(Boolean)
        .map((value) => toDateSafe(value))
        .filter(Boolean)
        .map((d) => d.getTime());

      if (!times.length) return "-";
      return formatDateTime(new Date(Math.max(...times)));
    },
  },

  watch: {
    // เปลี่ยนช่วงวันที่ → debounce แล้วดึงเฉพาะช่วงใหม่ (ใช้ cache ถ้าเคยโหลดแล้ว)
    fromDate() {
      this.scheduleRangeReload();
    },
    toDate() {
      this.scheduleRangeReload();
    },
    filterVehicle() {
      this.tableLimit = HISTORY_TABLE_PAGE_SIZE;
    },
    filterHourSlot() {
      this.tableLimit = HISTORY_TABLE_PAGE_SIZE;
    },
    gapMinutesInput() {
      this.renderRoute();
    },
    showVehicle1() {
      this.renderRoute();
    },
    showVehicle2() {
      this.renderRoute();
    },
    showVehicle3() {
      this.renderRoute();
    },
    showVehicle4() {
      this.renderRoute();
    },
  },

  methods: {
    normalizeVehicleId(input) {
      if (input === null || input === undefined) return "";

      if (typeof input === "string") return input.trim();
      if (typeof input === "number" || typeof input === "bigint" || typeof input === "boolean") {
        return String(input).trim();
      }

      if (typeof input === "object") {
        if ("vehicleId" in input) return this.normalizeVehicleId(input.vehicleId);
        if ("id" in input) return this.normalizeVehicleId(input.id);
        if ("key" in input) return this.normalizeVehicleId(input.key);
        if ("value" in input && typeof input.value !== "object") {
          return this.normalizeVehicleId(input.value);
        }
      }

      try {
        return String(input).trim();
      } catch {
        return "";
      }
    },

    displayVehicleText(vehicleId) {
      const id = this.normalizeVehicleId(vehicleId);
      if (!id) return "-";

      const plate = this.vehicleMappings?.[id]?.plate || "";
      if (plate) return `${id} → ${plate}`;
      return id;
    },

    pad(n) {
      return pad(n);
    },

    formatDateTime(value) {
      return formatDateTime(value);
    },

    formatCoord(value) {
      return formatNum(value, 6);
    },

    setStatus(text, type = "info") {
      this.status = text;
      this.statusType = type;
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
        const connected = !!snapshot.val();
        syncFirebaseBadge(connected, connected ? "เชื่อมต่อ Firebase ได้ปกติ" : "เชื่อมต่อไม่ได้");
      };

      firebaseInfoRef.on("value", firebaseInfoCallback, (err) => {
        console.error(err);
        syncFirebaseBadge(false, "เชื่อมต่อไม่ได้");
        this.setStatus(`อ่านสถานะการเชื่อมต่อ Firebase ไม่สำเร็จ: ${err.message || err}`, "error");
      });
    },

    ensureDateDefaults() {
      const today = todayISODate();
      if (!this.fromDate) this.fromDate = today;
      if (!this.toDate) this.toDate = today;
      if (this.fromDate > this.toDate) this.toDate = this.fromDate;
    },

    initFirebase() {
      if (
        !window.firebaseConfig ||
        !window.firebaseConfig.apiKey ||
        window.firebaseConfig.apiKey === "YOUR_API_KEY"
      ) {
        syncFirebaseBadge(false, "เชื่อมต่อไม่ได้");
        this.setStatus("ยังไม่ตั้งค่า Firebase config", "warn");
        return false;
      }

      try {
        if (!firebase.apps.length) firebase.initializeApp(window.firebaseConfig);
        if (!firebaseDb) firebaseDb = firebase.database();
        return true;
      } catch (err) {
        console.error(err);
        syncFirebaseBadge(false, "เชื่อมต่อไม่ได้");
        this.setStatus(`เริ่ม Firebase ไม่สำเร็จ: ${err.message || err}`, "error");
        return false;
      }
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

    async loadDeviceOptions() {
      if (!this.initFirebase()) return false;

      this.deviceLoading = true;

      try {
        // รายชื่อ device = ชื่อ node ใน locations ผ่าน shallow REST (ไม่ดาวน์โหลดจุด GPS) cache 10 นาที
        await this.loadVehicleMappings();
        const listing = await FQ.listVehicleIds(firebaseDb, { mappings: this.vehicleMappings || {} });
        if (listing.shallowError) throw listing.shallowError;
        const keys = listing.locationIds.slice();

        keys.sort((a, b) =>
          a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }),
        );
        this.deviceOptions = keys;

        if (!this.vehicleId1) this.vehicleId1 = keys[0] || "";
        if (!this.vehicleId2) this.vehicleId2 = keys[1] || "";
        if (!this.vehicleId3) this.vehicleId3 = keys[2] || "";
        if (!this.vehicleId4) this.vehicleId4 = keys[3] || "";

        return true;
      } catch (err) {
        console.error(err);
        this.setStatus(`อ่านรายชื่อ device ไม่สำเร็จ: ${err.message || err}`, "error");
        return false;
      } finally {
        this.deviceLoading = false;
      }
    },

    async ensureDeviceOptions() {
      if (this.deviceOptions.length) return true;
      return await this.loadDeviceOptions();
    },

    initMap() {
      if (mapInstance) return;

      mapInstance = L.map("map", { zoomControl: true, preferCanvas: true }).setView(
        [13.736717, 100.523186],
        6,
      );

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).addTo(mapInstance);

      historyLayerGroup = L.layerGroup().addTo(mapInstance);
      setTimeout(() => mapInstance.invalidateSize(), 100);
    },

    resetMapLayers() {
      if (!mapInstance) return;

      if (historyLayerGroup) historyLayerGroup.clearLayers();

      routeLayers.forEach((layer) => layer.remove());
      routeLayers = [];

      pointLayers.forEach((layer) => layer.remove());
      pointLayers = [];
    },

    getFilteredPoints(points) {
      const from = this.fromDate ? new Date(`${this.fromDate}T00:00:00`) : null;
      const to = this.toDate ? new Date(`${this.toDate}T23:59:59.999`) : null;
      const sorted = (points || [])
        .filter((p) => {
          if (!p.date) return false;
          if (from && p.date < from) return false;
          if (to && p.date > to) return false;
          return true;
        })
        .slice()
        .sort((a, b) => a.date.getTime() - b.date.getTime());

      const rows = [];
      let lastAccepted = null;

      sorted.forEach((p) => {
        const row = { ...p, isSuspicious: false, suspiciousReason: "" };
        const suspicious = lastAccepted ? isSuspiciousJump(lastAccepted, row) : null;

        if (suspicious) {
          row.isSuspicious = true;
          row.suspiciousReason = suspicious.reason;
          row.segmentMeters = null;
          row.cumulativeMeters = lastAccepted?.cumulativeMeters ?? null;
          row.cumulativeKm = lastAccepted?.cumulativeKm ?? null;
        } else {
          row.segmentMeters = lastAccepted
            ? haversineMeters(lastAccepted.lat, lastAccepted.lng, row.lat, row.lng)
            : 0;
          row.cumulativeMeters = lastAccepted
            ? (lastAccepted.cumulativeMeters || 0) + (row.segmentMeters || 0)
            : 0;
          row.cumulativeKm = (row.cumulativeMeters || 0) / 1000;
          lastAccepted = row;
        }

        rows.push(row);
      });

      return rows;
    },

    buildSegments(points) {
      const pts = (points || []).filter((p) => !p.isSuspicious);
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
        const isNewDay = !isSameCalendarDay(prev.date, curr.date);

        if (isGap || isNewDay) {
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
          sum += haversineMeters(
            seg[i - 1].lat,
            seg[i - 1].lng,
            seg[i].lat,
            seg[i].lng,
          );
        }
      }
      return sum / 1000;
    },

    parseSnapshot(snapshot) {
      const items = [];

      snapshot.forEach((child) => {
        const value = child.val() || {};
        const lat = Number(value.lat);
        const lng = Number(value.lng);

        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

        const timestampiso = String(value.timestampiso || child.key || "");
        const date = toDateSafe(timestampiso);
        if (!date) return;

        items.push({
          key: child.key,
          lat,
          lng,
          speed: Number.isFinite(Number(value.speed_kmh))
            ? Number(value.speed_kmh)
            : Number.isFinite(Number(value.speed))
              ? Number(value.speed)
              : null,
          accuracy: Number.isFinite(Number(value.accuracy))
            ? Number(value.accuracy)
            : null,
          timestampiso,
          date,
          raw: null, // ไม่เก็บ raw ของ Firebase (ไม่มีที่ใช้)
          pointNo: 0,
          segmentMeters: null,
          cumulativeMeters: null,
          cumulativeKm: null,
        });
      });

      items.sort((a, b) => {
        const ta = a.date ? a.date.getTime() : 0;
        const tb = b.date ? b.date.getTime() : 0;
        return ta - tb;
      });

      return numberHistoryPoints(items);
    },

    setTrackData(slot, points, fetchedAt = Date.now()) {
      // markRaw: ไม่ทำ deep reactive ทุกจุด (array ถูกแทนที่ทั้งก้อนเมื่อข้อมูลเปลี่ยน)
      this.tracks[slot].points = markRaw(points);
      this.tracks[slot].lastUpdatedAt = new Date(fetchedAt).toISOString();
      this.tracks[slot].status = points.length
        ? `โหลดแล้ว ${points.length} จุด`
        : "ไม่พบข้อมูล";
      this.tracks[slot].statusType = points.length ? "ok" : "warn";
    },

    scheduleRangeReload() {
      this.tableLimit = HISTORY_TABLE_PAGE_SIZE;
      loadSeq += 1; // ทิ้งผลของ request ที่กำลังวิ่งอยู่
      if (rangeDebounceTimer) clearTimeout(rangeDebounceTimer);
      rangeDebounceTimer = setTimeout(() => {
        rangeDebounceTimer = null;
        this.loadTracks();
      }, RANGE_DEBOUNCE_MS);
    },

    // ปุ่ม "โหลดข้อมูล" = บังคับดึงใหม่ (bypass cache)
    reloadTracks() {
      return this.loadTracks({ force: true });
    },

    // opts.force = ข้าม cache ในหน่วยความจำ
    async loadTracks(opts = {}) {
      const force = !!(opts && opts.force === true);
      if (!this.initFirebase()) return;

      if (rangeDebounceTimer) {
        clearTimeout(rangeDebounceTimer);
        rangeDebounceTimer = null;
      }

      this.ensureDateDefaults();

      const ok = await this.ensureDeviceOptions();
      if (!ok) {
        this.loading = false;
        this.setStatus("ยังไม่พบรายชื่อ device จาก Firebase", "warn");
        return;
      }

      const configs = this.vehicleConfigs.filter((cfg) => cfg.vehicleId);
      if (!configs.length) {
        this.loading = false;
        this.setStatus("กรุณาเลือก device อย่างน้อย 1 คัน", "warn");
        return;
      }

      const from = this.fromDate;
      const to = this.toDate;
      const open = to >= todayISODate();

      // ช่วงยาว / จุดเยอะ → ยืนยันก่อน (นับเฉพาะคันที่ต้องดึงจริง)
      const needFetch = new Set(
        configs
          .filter((cfg) => force || !getCachedTrack(trackCacheKey(cfg.vehicleId, from, to)))
          .map((cfg) => cfg.vehicleId),
      );
      if (needFetch.size) {
        const days = daysInRange(from, to);
        const estimated = days * needFetch.size * ESTIMATED_POINTS_PER_VEHICLE_PER_DAY;
        if (days > CONFIRM_RANGE_DAYS || estimated > CONFIRM_ESTIMATED_POINTS) {
          const confirmed = window.confirm(
            `ช่วงที่เลือก ${days} วัน (${needFetch.size} คัน) คาดว่าประมาณ ${estimated.toLocaleString()} จุด\n` +
              "อาจโหลดนานและใช้ปริมาณดาวน์โหลด Firebase มาก ต้องการโหลดต่อหรือไม่?",
          );
          if (!confirmed) {
            this.loading = false;
            this.setStatus("ยกเลิกการโหลดข้อมูลช่วงนี้", "warn");
            return;
          }
        }
      }

      loadSeq += 1;
      const seq = loadSeq;
      this.loading = true;
      this.setStatus("กำลังดึงข้อมูล...", "info");

      try {
        // รถคันเดียวกันที่ถูกเลือกซ้ำหลายช่อง ดึงครั้งเดียว
        const inflight = new Map();
        const fetchVehicle = (vehicleId) => {
          const key = trackCacheKey(vehicleId, from, to);
          if (!force) {
            const cached = getCachedTrack(key);
            if (cached) return Promise.resolve(cached);
          }
          if (!inflight.has(key)) {
            inflight.set(
              key,
              FQ.fetchRange(firebaseDb, vehicleId, from, to).then((snapshot) => {
                const entry = { points: markRaw(this.parseSnapshot(snapshot)), fetchedAt: Date.now(), open };
                rememberTrack(key, entry);
                return entry;
              }),
            );
          }
          return inflight.get(key);
        };

        const results = await Promise.all(
          configs.map(async (cfg) => {
            const entry = await fetchVehicle(cfg.vehicleId);
            return { slot: cfg.slot, points: entry.points, fetchedAt: entry.fetchedAt };
          }),
        );

        if (seq !== loadSeq) return; // มี request ใหม่กว่าแล้ว ทิ้งผลนี้

        results.forEach((r) => this.setTrackData(r.slot, r.points, r.fetchedAt));
        this.renderRoute();
      } catch (err) {
        console.error(err);
        if (seq !== loadSeq) return;
        this.setStatus(`โหลดข้อมูลไม่สำเร็จ: ${err.message || err}`, "error");
      } finally {
        if (seq === loadSeq) this.loading = false;
      }
    },

    // ลบจุดออกจาก state ในเครื่อง (ไม่ต้องโหลดใหม่ทั้งหมด) แล้วคำนวณเลขจุด/ระยะใหม่
    removePointLocally(vehicleId, key) {
      const renumber = (points) =>
        markRaw(numberHistoryPoints(points.filter((p) => p.key !== key).map((p) => ({ ...p }))));

      const updatedBySource = new Map();
      Object.keys(this.tracks).forEach((slot) => {
        const cfg = this.vehicleConfigs.find((c) => c.slot === slot);
        if (!cfg || cfg.vehicleId !== vehicleId) return;
        const current = this.tracks[slot].points || [];
        if (!current.some((p) => p.key === key)) return;
        if (!updatedBySource.has(current)) updatedBySource.set(current, renumber(current));
        this.tracks[slot].points = updatedBySource.get(current);
      });

      trackCache.forEach((entry, cacheKey) => {
        if (!cacheKey.startsWith(`${vehicleId}|`)) return;
        if (!entry.points.some((p) => p.key === key)) return;
        const updated = updatedBySource.get(entry.points) || renumber(entry.points);
        trackCache.set(cacheKey, { ...entry, points: updated });
      });
    },

    renderRoute() {
      this.resetMapLayers();
      if (!mapInstance) this.initMap();

      const summaries = this.visibleTrackSummaries;
      const totalPoints = summaries.reduce(
        (sum, track) => sum + track.filteredPoints.length,
        0,
      );

      if (!totalPoints) {
        this.setStatus("ไม่พบข้อมูลในช่วงวันที่/รถที่เลือก", "warn");
        return;
      }

      let polyCount = 0;
      const group = historyLayerGroup || mapInstance;

      // marker บน canvas (preferCanvas) และสร้าง popup ตอนคลิกเท่านั้น
      const addMarker = (p, style, buildPopup) => {
        const marker = L.circleMarker([p.lat, p.lng], { ...style, interactive: true });
        marker.on("click", () => {
          L.popup().setLatLng(marker.getLatLng()).setContent(buildPopup()).openOn(mapInstance);
        });
        marker.addTo(group);
        pointLayers.push(marker);
        return marker;
      };

      summaries.forEach((track) => {
        const pts = track.filteredPoints;
        const segments = track.segments;
        const color = track.color;
        const title = `<strong>${track.label} — ${track.displayLabel || track.vehicleId}</strong>`;

        if (!pts.length) return;

        if (pts.length === 1) {
          const p = pts[0];
          addMarker(
            p,
            { radius: 9, color, fillColor: color, fillOpacity: 1, weight: 0 },
            () =>
              `${title}<br>${formatDateTime(p.timestampiso)}<br>Lat ${formatNum(p.lat, 6)}<br>Lng ${formatNum(
                p.lng,
                6,
              )}<br>Speed ${this.formatSpeed(p.speed)}<br>Acc ${this.formatAccuracy(
                p.accuracy,
              )}<br>ระยะจุดนี้ ${p.segmentMeters != null ? p.segmentMeters.toFixed(2) : "-"} m`,
          );
          return;
        }

        // ถ้าจุดของคันนี้เกิน ~5,000 จุด แสดง marker ต้น/ปลายแต่ละช่วง + ทุก k จุด (เส้นยังใช้จุดครบ)
        const segmentPointTotal = segments.reduce((sum, seg) => sum + seg.length, 0);
        const markerStep =
          segmentPointTotal > MAX_MARKERS_PER_TRACK ? Math.ceil(segmentPointTotal / MAX_MARKERS_PER_TRACK) : 1;
        let runningIndex = 0;

        segments.forEach((segment, segIndex) => {
          if (!segment.length) return;

          if (segment.length >= 2) {
            polyCount += 1;
            const latlngs = segment.map((p) => [p.lat, p.lng]);
            const polyline = L.polyline(latlngs, {
              color,
              weight: 6,
              opacity: 1,
              lineCap: "round",
              lineJoin: "round",
              className: "route-polyline",
              interactive: false,
            }).addTo(group);

            routeLayers.push(polyline);
          }

          const start = segment[0];
          const end = segment[segment.length - 1];
          const edgeStyle = { radius: 9, color, fillColor: color, fillOpacity: 1, weight: 0 };

          addMarker(
            start,
            edgeStyle,
            () =>
              `${title}<br>เริ่มช่วง ${segIndex + 1
              }<br>${formatDateTime(start.timestampiso)}<br>Speed ${this.formatSpeed(start.speed)}<br>Acc ${this.formatAccuracy(start.accuracy)}<br>ระยะจุดนี้ ${start.segmentMeters != null ? start.segmentMeters.toFixed(2) : "-"} m`,
          );

          addMarker(
            end,
            edgeStyle,
            () =>
              `${title}<br>สิ้นสุดช่วง ${segIndex + 1
              }<br>${formatDateTime(end.timestampiso)}<br>Speed ${this.formatSpeed(end.speed)}<br>Acc ${this.formatAccuracy(end.accuracy)}<br>ระยะจุดนี้ ${end.segmentMeters != null ? end.segmentMeters.toFixed(2) : "-"
              } m`,
          );

          const pointStyle = { radius: 6, color, fillColor: color, fillOpacity: 0.9, weight: 0 };
          segment.forEach((p, idx) => {
            const globalIdx = runningIndex + idx;
            if (idx === 0 || idx === segment.length - 1) return;
            if (markerStep > 1 && globalIdx % markerStep !== 0) return;

            addMarker(
              p,
              pointStyle,
              () =>
                `${title}<br>${formatDateTime(
                  p.timestampiso,
                )}<br>Lat ${formatNum(p.lat, 6)}<br>Lng ${formatNum(
                  p.lng,
                  6,
                )}<br>Speed ${this.formatSpeed(p.speed)}<br>Acc ${this.formatAccuracy(
                  p.accuracy,
                )}<br>ระยะจุดนี้ ${p.segmentMeters != null ? p.segmentMeters.toFixed(2) : "-"} m`,
            );
          });

          runningIndex += segment.length;
        });
      });

      this.fitToRoute();

      if (polyCount === 0) {
        this.setStatus("พบข้อมูล แต่มีแต่จุดเดี่ยว ยังไม่มีเส้นให้วาด", "warn");
        return;
      }

      this.setStatus(
        `โหลดข้อมูลรวม ${totalPoints} จุด และแยกเป็น ${polyCount} ช่วง`,
        "ok",
      );
    },

    fitToRoute() {
      if (!mapInstance || !this.visibleTrackSummaries.length) return;

      const latlngs = this.visibleTrackSummaries.flatMap((track) =>
        track.filteredPoints.map((p) => [p.lat, p.lng]),
      );

      if (!latlngs.length) return;

      const bounds = L.latLngBounds(latlngs);
      if (bounds.isValid()) {
        mapInstance.fitBounds(bounds.pad(0.15));
      }
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

    focusPoint(row) {
      if (!row || !mapInstance) return;

      mapInstance.setView([row.lat, row.lng], Math.max(mapInstance.getZoom(), 16));

      const warningText = row.isSuspicious
        ? `<br/><strong style="color:#dc2626">จุดนี้ถูกมองว่าเป็น outlier</strong>${
            row.suspiciousReason ? `<br/>${row.suspiciousReason}` : ""
          }`
        : "";

      const popup = L.popup().setLatLng([row.lat, row.lng]).setContent(
        `<strong>${row.label} — ${row.vehicleId}</strong><br/><strong>${formatDateTime(
          row.timestampiso,
        )}</strong><br/>Lat: ${formatNum(row.lat, 6)}<br/>Lng: ${formatNum(
          row.lng,
          6,
        )}<br/>Speed: ${this.formatSpeed(row.speed)}<br/>ACC: ${this.formatAccuracy(
          row.accuracy,
        )}${warningText}<br/>ระยะจุดนี้: ${row.segmentMeters != null ? row.segmentMeters.toFixed(2) : "-"
        } m<br/>ระยะวันนี้สะสม: ${row.cumulativeKm != null ? row.cumulativeKm.toFixed(2) : "-"} km`,
      );

      popup.openOn(mapInstance);
    },

    async deletePoint(row) {
      if (!row || !row.vehicleId || !row.key) return;

      const label = `${row.label || row.vehicleId} • ${formatDateTime(row.timestampiso)}`;
      const confirmed = window.confirm(`ลบจุดนี้ใช่ไหม?\n${label}`);
      if (!confirmed) return;

      if (!this.initFirebase()) return;

      this.loading = true;
      this.setStatus("กำลังลบจุด...", "info");

      try {
        await firebaseDb.ref(`locations/${row.vehicleId}/${row.key}`).remove();
        this.setStatus("ลบจุดเรียบร้อยแล้ว", "ok");
        // เอาจุดออกจาก state ในเครื่อง แล้ววาดใหม่ (ไม่ดึงข้อมูลทั้งช่วงซ้ำ)
        this.removePointLocally(row.vehicleId, row.key);
        this.renderRoute();
      } catch (err) {
        console.error(err);
        this.setStatus(`ลบจุดไม่สำเร็จ: ${err.message || err}`, "error");
      } finally {
        this.loading = false;
      }
    },

    exportCsv() {
      const rows = this.visibleAllFilteredPoints;
      if (!rows.length) return;

      const headers = [
        "รถ",
        "vehicleId",
        "จุดที่",
        "เวลา",
        "Lat",
        "Lng",
        "Speed(km/h)",
        "Accuracy(m)",
        "ระยะจุดนี้ (m)",
        "ระยะวันนี้สะสม (km)",
      ];

      const csvLines = [headers.map(escapeCsv).join(",")];

      rows.forEach((p) => {
        csvLines.push(
          [
            p.label,
            p.vehicleId,
            p.pointNo ?? "",
            formatDateTime(p.timestampiso),
            p.lat,
            p.lng,
            p.speed ?? "",
            typeof p.speed === "number" && Number.isFinite(p.speed)
              ? p.speed.toFixed(1)
              : "",
            p.accuracy ?? "",
            p.segmentMeters != null ? p.segmentMeters.toFixed(2) : "",
            p.cumulativeKm != null ? p.cumulativeKm.toFixed(2) : "",
          ]
            .map(escapeCsv)
            .join(","),
        );
      });

      const blob = new Blob(["\ufeff" + csvLines.join("\n")], {
        type: "text/csv;charset=utf-8;",
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, "0");
      const dd = String(today.getDate()).padStart(2, "0");

      a.href = url;
      a.download = `gps-history-${yyyy}${mm}${dd}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },

    clearTrack() {
      Object.keys(this.tracks).forEach((slot) => {
        this.tracks[slot].points = [];
        this.tracks[slot].lastUpdatedAt = null;
        this.tracks[slot].status = "ยังไม่ได้โหลด";
        this.tracks[slot].statusType = "info";
      });

      this.resetMapLayers();
      this.setStatus("ล้างข้อมูลบนหน้าแล้ว", "info");

      if (mapInstance) {
        mapInstance.setView([13.736717, 100.523186], 6);
      }
    },

    resizeMap() {
      if (mapInstance) {
        setTimeout(() => mapInstance.invalidateSize(), 50);
      }
    },
  },

  async mounted() {
    this.ensureDateDefaults();
    this.subscribeFirebaseConnectionState();
    this.initMap();

    this.resizeHandler = () => this.resizeMap();
    window.addEventListener("resize", this.resizeHandler);

    await this.loadDeviceOptions();
    await this.loadTracks();
  },

  beforeUnmount() {
    if (rangeDebounceTimer) clearTimeout(rangeDebounceTimer);
    loadSeq += 1;
    if (this.resizeHandler) {
      window.removeEventListener("resize", this.resizeHandler);
    }

    if (firebaseInfoRef && firebaseInfoCallback) {
      try {
        firebaseInfoRef.off("value", firebaseInfoCallback);
      } catch (err) {
        console.warn(err);
      }
    }

    if (mapInstance) {
      mapInstance.remove();
      mapInstance = null;
    }
  },
}).mount("#app");