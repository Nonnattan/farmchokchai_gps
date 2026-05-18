const { createApp } = Vue;

let firebaseDb = null;

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

function todayBounds() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { start, end };
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

function colorForId(vehicleId) {
  let hash = 0;
  for (let i = 0; i < vehicleId.length; i += 1) {
    hash = (hash * 31 + vehicleId.charCodeAt(i)) >>> 0;
  }
  return COLORS[hash % COLORS.length];
}

function formatDateTime(value) {
  const d = toDateSafe(value);
  if (!d) return "-";
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

createApp({
  data() {
    return {
      loading: false,
      status: "พร้อมใช้งาน",
      statusType: "info",
      liveByVehicle: {},
      mappingsByVehicle: {},
      refreshTimer: null,
      deviceCount: 0,
      todayTotalPoints: 0,
      lastUpdatedAt: null,
    };
  },

  computed: {
    liveVehicles() {
      const entries = Object.entries(this.liveByVehicle).map(([vehicleId, data]) => {
        const color = colorForId(vehicleId);
        const points = data.points || [];
        const latest = points[points.length - 1] || null;
        const distanceKm = data.distanceKm || 0;
        return {
          vehicleId,
          color,
          points,
          latest,
          latestTime: latest?.date ? latest.date.getTime() : 0,
          pointCount: points.length,
          segmentCount: data.segmentCount || 0,
          distanceText: `${distanceKm.toFixed(2)} km`,
          plateText: this.getPlateText(vehicleId),
        };
      });

      entries.sort((a, b) => b.latestTime - a.latestTime || a.vehicleId.localeCompare(b.vehicleId, "th"));
      return entries;
    },

    mappingRows() {
      return Object.entries(this.mappingsByVehicle)
        .map(([vehicleId, data]) => ({
          vehicleId,
          plate: data.plate || "",
          note: data.note || "",
          updatedAt: data.updatedAt || null,
        }))
        .sort((a, b) => a.vehicleId.localeCompare(b.vehicleId, "th"));
    },

    liveVehicleCount() {
      return String(this.liveVehicles.length);
    },

    mappingCount() {
      return String(this.mappingRows.length);
    },

    todayPointCount() {
      return String(this.todayTotalPoints);
    },

    lastUpdatedText() {
      if (!this.lastUpdatedAt) return "-";
      return formatDateTime(this.lastUpdatedAt);
    },
  },

  methods: {
    pad(n) {
      return pad(n);
    },

    formatDateTime(value) {
      return formatDateTime(value);
    },

    setStatus(text, type = "info") {
      this.status = text;
      this.statusType = type;
    },

    initFirebase() {
      if (!window.firebaseConfig || !window.firebaseConfig.apiKey) {
        this.setStatus("ยังไม่ตั้งค่า Firebase config", "warn");
        return false;
      }

      try {
        if (!firebase.apps.length) firebase.initializeApp(window.firebaseConfig);
        if (!firebaseDb) firebaseDb = firebase.database();
        return true;
      } catch (err) {
        console.error(err);
        this.setStatus(`เริ่ม Firebase ไม่สำเร็จ: ${err.message || err}`, "error");
        return false;
      }
    },

    getPlateText(vehicleId) {
      const map = this.mappingsByVehicle[vehicleId];
      return map && map.plate ? map.plate : "ยังไม่จับคู่";
    },

    parseTodayPoints(snapshot) {
      const { start, end } = todayBounds();
      const points = [];

      snapshot.forEach((child) => {
        const value = child.val() || {};
        const lat = Number(value.lat);
        const lng = Number(value.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

        const timestampiso = String(value.timestampiso || child.key || "");
        const date = toDateSafe(timestampiso);
        if (!date) return;
        if (date < start || date > end) return;

        points.push({
          key: child.key,
          lat,
          lng,
          timestampiso,
          date,
        });
      });

      points.sort((a, b) => a.date.getTime() - b.date.getTime());
      points.forEach((p, idx) => {
        p.pointNo = idx + 1;
      });

      return points;
    },

    buildDistanceKm(points) {
      if (!points || points.length < 2) return 0;
      let sum = 0;
      for (let i = 1; i < points.length; i += 1) {
        sum += haversineMeters(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
      }
      return sum / 1000;
    },

    async refreshAll() {
      if (!this.initFirebase()) return;

      this.loading = true;
      this.setStatus("กำลังดึงข้อมูล dashboard...", "info");

      try {
        const [mappingSnap, locationsSnap] = await Promise.all([
          firebaseDb.ref("vehicle_mappings").once("value"),
          firebaseDb.ref("locations").once("value"),
        ]);

        const mappings = {};
        mappingSnap.forEach((child) => {
          const value = child.val() || {};
          const vehicleId = String(child.key || value.vehicle_id || "").trim();
          if (!vehicleId) return;
          mappings[vehicleId] = {
            plate: String(value.plate || value.license_plate || "").trim(),
            note: String(value.note || "").trim(),
            updatedAt: value.updatedAt || value.updated_at || null,
          };
        });
        this.mappingsByVehicle = mappings;

        const live = {};
        let totalPoints = 0;

        locationsSnap.forEach((vehicleNode) => {
          const vehicleId = String(vehicleNode.key || "").trim();
          if (!vehicleId) return;
          const points = this.parseTodayPoints(vehicleNode);
          if (!points.length) return;

          totalPoints += points.length;
          live[vehicleId] = {
            points,
            segmentCount: points.length >= 2 ? 1 : 0,
            distanceKm: this.buildDistanceKm(points),
          };
        });

        this.liveByVehicle = live;
        this.todayTotalPoints = totalPoints;
        this.lastUpdatedAt = new Date().toISOString();
        this.deviceCount = Object.keys(live).length;

        if (this.deviceCount) {
          this.setStatus(`อัปเดตแล้ว: พบรถวันนี้ ${this.deviceCount} คัน`, "ok");
        } else {
          this.setStatus("ยังไม่พบรถวิ่งของวันนี้", "warn");
        }
      } catch (err) {
        console.error(err);
        this.setStatus(`โหลด dashboard ไม่สำเร็จ: ${err.message || err}`, "error");
      } finally {
        this.loading = false;
      }
    },
  },

  mounted() {
    this.refreshAll();
    this.refreshTimer = setInterval(() => {
      this.refreshAll();
    }, 30000);
  },

  beforeUnmount() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  },
}).mount("#app");
