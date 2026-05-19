const { createApp } = Vue;

let firebaseDb = null;
let mapInstance = null;
let routeLayers = [];
let pointLayers = [];
let liveRef = null;
let liveCallback = null;

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

createApp({
  data() {
    return {
      loading: false,
      status: "กำลังรอข้อมูลรถวันนี้...",
      statusType: "info",
      gapMinutesInput: "10",
      vehiclesById: {},
      visibleVehicles: {},
      vehicleMappings: {},
      lastRefreshAt: null,
      mapReady: false,
      resizeHandler: null,

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

    vehicleLabelMap() {
      return this.vehicleMappings || {};
    },

    vehicleSummaries() {
      const entries = Object.entries(this.vehiclesById).map(([vehicleId, data]) => {
        const color = colorForId(vehicleId);
        const points = data.points || [];
        const segments = this.buildSegments(points);
        const distanceKm = this.distanceKmFromSegments(segments);
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
    visiblePoints() {
      const rows = [];
      for (const vehicle of this.visibleVehicleSummaries) {
        vehicle.points.forEach((p) => {
          rows.push({
            ...p,
            vehicleId: vehicle.vehicleId,
            color: vehicle.color,
            displayLabel: vehicle.displayLabel || vehicle.vehicleId,
            plateText: vehicle.plateText || "",
          });
        });
      }

      rows.sort((a, b) => {
        const ta = a.date ? a.date.getTime() : 0;
        const tb = b.date ? b.date.getTime() : 0;
        if (tb !== ta) return tb - ta;
        return String(a.vehicleId || "").localeCompare(String(b.vehicleId || ""), "th");
      });

      return rows;
    },
    filteredPoints() {
      return this.visiblePoints.filter((p) => {
        if (this.filterVehicle && p.vehicleId !== this.filterVehicle) {
          return false;
        }

        if (this.filterHourSlot !== "" && p.date) {
          const slot = Number(this.filterHourSlot);
          if (Number.isFinite(slot)) {
            if (p.date.getHours() !== slot) return false;
          }
        }

        if (p.date && (this.filterStartTime || this.filterEndTime)) {
          const hours = pad(p.date.getHours());
          const mins = pad(p.date.getMinutes());
          const timeStr = `${hours}:${mins}`;

          if (this.filterStartTime && timeStr < this.filterStartTime) return false;
          if (this.filterEndTime && timeStr > this.filterEndTime) return false;
        }

        return true;
      });
    },
    totalVehiclesText() {
      return String(this.visibleVehicleSummaries.length);
    },
    totalPointsText() {
      return String(this.visiblePoints.length);
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
  },
  watch: {
    gapMinutesInput() {
      this.renderRoute();
    },
    visibleVehicles: {
      deep: true,
      handler() {
        this.renderRoute();
      },
    },
  },
  methods: {
    // ให้ template เรียก pad() ได้
    pad(n) {
      return pad(n);
    },
    setStatus(text, type = "info") {
      this.status = text;
      this.statusType = type;
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

    displayVehicleText(vehicleId) {
      const id = String(vehicleId || "").trim();
      if (!id) return "-";

      const plate = this.vehicleMappings?.[id]?.plate || "";
      return plate ? `${id} → ${plate}` : id;
    },

    initMap() {
      if (mapInstance) return;

      mapInstance = L.map("map", { zoomControl: true }).setView([13.736717, 100.523186], 6);

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).addTo(mapInstance);

      this.mapReady = true;
      setTimeout(() => mapInstance.invalidateSize(), 100);
    },
    resetMapLayers() {
      if (!mapInstance) return;
      routeLayers.forEach((layer) => layer.remove());
      routeLayers = [];
      pointLayers.forEach((layer) => layer.remove());
      pointLayers = [];
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
    parseVehicleSnapshot(vehicleSnapshot) {
      const points = [];
      const { start, end } = getTodayBounds();

      vehicleSnapshot.forEach((child) => {
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
          speed: Number.isFinite(Number(value.speed_kmh))
            ? Number(value.speed_kmh)
            : Number.isFinite(Number(value.speed))
              ? Number(value.speed)
              : null,
          accuracy: Number.isFinite(Number(value.accuracy)) ? Number(value.accuracy) : null,
          timestampiso,
          date,
          raw: value,
          pointNo: 0,
          segmentMeters: 0,
          cumulativeMeters: 0,
          cumulativeKm: 0,
        });
      });

      points.sort((a, b) => {
        const ta = a.date ? a.date.getTime() : 0;
        const tb = b.date ? b.date.getTime() : 0;
        return ta - tb;
      });

      points.forEach((p, idx) => {
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
      });

      return points;
    },
    detachLiveListener() {
      if (liveRef && liveCallback) {
        try {
          liveRef.off("value", liveCallback);
        } catch (err) {
          console.warn(err);
        }
      }
      liveRef = null;
      liveCallback = null;
    },
    async subscribeTodayLive() {
      if (!this.initFirebase()) return;

      await this.loadVehicleMappings();

      this.loading = true;
      this.setStatus("กำลังโหลดรถวิ่งของวันนี้...", "info");
      this.detachLiveListener();

      liveRef = firebaseDb.ref("locations");
      liveCallback = (snapshot) => {
        const result = {};
        const visibleIds = new Set();

        snapshot.forEach((vehicleNode) => {
          const vehicleId = String(vehicleNode.key || "").trim();
          if (!vehicleId) return;

          const points = this.parseVehicleSnapshot(vehicleNode);
          if (!points.length) return;

          const latest = points[points.length - 1];
          result[vehicleId] = {
            points,
            lastSeenAt: latest?.date ? latest.date.toISOString() : new Date().toISOString(),
          };
          visibleIds.add(vehicleId);
        });

        this.vehiclesById = result;

        Object.keys(this.visibleVehicles).forEach((vehicleId) => {
          if (!visibleIds.has(vehicleId)) delete this.visibleVehicles[vehicleId];
        });

        Object.keys(result).forEach((vehicleId) => {
          if (!(vehicleId in this.visibleVehicles)) this.visibleVehicles[vehicleId] = true;
        });

        this.lastRefreshAt = new Date().toISOString();
        this.renderRoute();
        this.loading = false;

        const count = Object.keys(result).length;
        if (count) this.setStatus(`พบรถวิ่งวันนี้ ${count} คัน`, "ok");
        else this.setStatus("ยังไม่พบรถวิ่งของวันนี้", "warn");
      };

      liveRef.on("value", liveCallback, (err) => {
        console.error(err);
        this.setStatus(`โหลดข้อมูลไม่สำเร็จ: ${err.message || err}`, "error");
        this.loading = false;
      });
    },
    toggleAllVehicles(show) {
      this.vehicleSummaries.forEach((v) => {
        this.visibleVehicles[v.vehicleId] = show;
      });
      this.renderRoute();
    },
    renderRoute() {
      this.resetMapLayers();
      if (!mapInstance) this.initMap();

      const summaries = this.visibleVehicleSummaries;
      const totalPoints = summaries.reduce((sum, v) => sum + v.points.length, 0);

      if (!totalPoints) return;

      summaries.forEach((vehicle) => {
        const pts = vehicle.points;
        const segments = vehicle.segments;
        const color = vehicle.color;

        if (!pts.length) return;

        if (pts.length === 1) {
          const p = pts[0];
          const marker = L.circleMarker([p.lat, p.lng], {
            radius: 8,
            color,
            fillColor: color,
            fillOpacity: 0.9,
            weight: 3,
          })
            .addTo(mapInstance)
            .bindPopup(
              `<strong>${vehicle.displayLabel || vehicle.vehicleId}</strong><br>${this.formatDateTime(p.timestampiso)}<br>Lat ${formatNum(
                p.lat,
                6,
              )}<br>Lng ${formatNum(p.lng, 6)}<br>Speed ${this.formatSpeed(p.speed)}`,
            );
          pointLayers.push(marker);
          return;
        }

        segments.forEach((segment, segIndex) => {
          if (!segment.length) return;

          if (segment.length >= 2) {
            const latlngs = segment.map((p) => [p.lat, p.lng]);
            const polyline = L.polyline(latlngs, {
              color,
              weight: 5,
              opacity: 0.95,
              lineCap: "round",
              lineJoin: "round",
            }).addTo(mapInstance);
            routeLayers.push(polyline);
          }

          const start = segment[0];
          const end = segment[segment.length - 1];

          const startMarker = L.circleMarker([start.lat, start.lng], {
            radius: 8,
            color,
            fillColor: color,
            fillOpacity: 0.9,
            weight: 3,
          })
            .addTo(mapInstance)
            .bindPopup(
              `<strong>${vehicle.displayLabel || vehicle.vehicleId}</strong><br>เริ่มช่วง ${segIndex + 1}<br>${this.formatDateTime(
                start.timestampiso,
              )}`,
            );

          const endMarker = L.circleMarker([end.lat, end.lng], {
            radius: 8,
            color,
            fillColor: color,
            fillOpacity: 0.95,
            weight: 3,
          })
            .addTo(mapInstance)
            .bindPopup(
              `<strong>${vehicle.displayLabel || vehicle.vehicleId}</strong><br>สิ้นสุดช่วง ${segIndex + 1}<br>${this.formatDateTime(
                end.timestampiso,
              )}`,
            );

          pointLayers.push(startMarker, endMarker);

          segment.forEach((p, idx) => {
            if (idx === 0 || idx === segment.length - 1) return;
            const marker = L.circleMarker([p.lat, p.lng], {
              radius: 5,
              color: "#e2e8f0",
              fillColor: color,
              fillOpacity: 0.75,
              weight: 2,
            })
              .addTo(mapInstance)
              .bindPopup(
                `<strong>${vehicle.displayLabel || vehicle.vehicleId}</strong><br>${this.formatDateTime(
                  p.timestampiso,
                )}<br>Speed ${this.formatSpeed(p.speed)}`,
              );
            pointLayers.push(marker);
          });
        });
      });

      this.fitToRoute();
    },
    fitToRoute() {
      if (!mapInstance || !this.visiblePoints.length) return;
      const latlngs = this.visiblePoints.map((p) => [p.lat, p.lng]);
      const bounds = L.latLngBounds(latlngs);
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
          )}<br/>Speed: ${this.formatSpeed(row.speed)}<br/>ระยะจุดนี้: ${
            row.segmentMeters != null ? row.segmentMeters.toFixed(2) : "-"
          } m<br/>ระยะรวม: ${
            row.cumulativeKm != null ? row.cumulativeKm.toFixed(2) : "-"
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
    this.subscribeTodayLive();
  },
  beforeUnmount() {
    this.detachLiveListener();
    if (this.resizeHandler) window.removeEventListener("resize", this.resizeHandler);
    if (mapInstance) {
      mapInstance.remove();
      mapInstance = null;
    }
  },
}).mount("#app");