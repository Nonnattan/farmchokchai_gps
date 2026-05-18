const { createApp } = Vue;

let firebaseDb = null;
let mapInstance = null;
let routeLayers = [];
let pointLayers = [];

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
          const latest = filteredPoints.length
            ? filteredPoints[filteredPoints.length - 1]
            : null;

          return {
            ...cfg,
            latest,
            pointCount: filteredPoints.length,
            segmentCount: segments.filter((s) => s.length >= 2).length,
            distanceKm,
            distanceText: `${distanceKm.toFixed(2)} km`,
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

    totalDistanceKm() {
      return this.visibleTrackSummaries.reduce(
        (sum, track) => sum + track.distanceKm,
        0,
      );
    },

    totalDistanceText() {
      return `${this.totalDistanceKm.toFixed(2)} km`;
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
    fromDate() {
      this.renderRoute();
    },
    toDate() {
      this.renderRoute();
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

    async loadDeviceOptions() {
      if (!this.initFirebase()) return false;

      this.deviceLoading = true;

      try {
        const snap = await firebaseDb.ref("locations").once("value");
        const keys = [];

        snap.forEach((child) => {
          const key = String(child.key || "").trim();
          if (key) keys.push(key);
        });

        keys.sort((a, b) =>
          a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }),
        );
        this.deviceOptions = keys;

        await this.loadVehicleMappings();

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

      mapInstance = L.map("map", { zoomControl: true }).setView(
        [13.736717, 100.523186],
        6,
      );

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).addTo(mapInstance);

      setTimeout(() => mapInstance.invalidateSize(), 100);
    },

    resetMapLayers() {
      if (!mapInstance) return;

      routeLayers.forEach((layer) => layer.remove());
      routeLayers = [];

      pointLayers.forEach((layer) => layer.remove());
      pointLayers = [];
    },

    getFilteredPoints(points) {
      const from = this.fromDate ? new Date(`${this.fromDate}T00:00:00`) : null;
      const to = this.toDate ? new Date(`${this.toDate}T23:59:59.999`) : null;

      return (points || []).filter((p) => {
        if (!p.date) return false;
        if (from && p.date < from) return false;
        if (to && p.date > to) return false;
        return true;
      });
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
          raw: value,
          pointNo: 0,
          segmentMeters: null,
        });
      });

      items.sort((a, b) => {
        const ta = a.date ? a.date.getTime() : 0;
        const tb = b.date ? b.date.getTime() : 0;
        return ta - tb;
      });

      items.forEach((p, idx) => {
        p.pointNo = idx + 1;
        if (idx === 0) {
          p.segmentMeters = 0;
        } else {
          const prev = items[idx - 1];
          p.segmentMeters = haversineMeters(prev.lat, prev.lng, p.lat, p.lng);
        }
      });

      return items;
    },

    setTrackData(slot, points) {
      this.tracks[slot].points = points;
      this.tracks[slot].lastUpdatedAt = new Date().toISOString();
      this.tracks[slot].status = points.length
        ? `โหลดแล้ว ${points.length} จุด`
        : "ไม่พบข้อมูล";
      this.tracks[slot].statusType = points.length ? "ok" : "warn";
    },

    async loadTracks() {
      if (!this.initFirebase()) return;

      this.ensureDateDefaults();

      const ok = await this.ensureDeviceOptions();
      if (!ok) {
        this.setStatus("ยังไม่พบรายชื่อ device จาก Firebase", "warn");
        return;
      }

      const configs = this.vehicleConfigs.filter((cfg) => cfg.vehicleId);
      if (!configs.length) {
        this.setStatus("กรุณาเลือก device อย่างน้อย 1 คัน", "warn");
        return;
      }

      this.loading = true;
      this.setStatus("กำลังดึงข้อมูล...", "info");

      try {
        const results = await Promise.all(
          configs.map(async (cfg) => {
            const ref = firebaseDb.ref(`locations/${cfg.vehicleId}`);
            const snapshot = await ref.orderByKey().once("value");
            return {
              slot: cfg.slot,
              points: this.parseSnapshot(snapshot),
            };
          }),
        );

        results.forEach((r) => this.setTrackData(r.slot, r.points));
        this.renderRoute();
      } catch (err) {
        console.error(err);
        this.setStatus(`โหลดข้อมูลไม่สำเร็จ: ${err.message || err}`, "error");
      } finally {
        this.loading = false;
      }
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

      summaries.forEach((track) => {
        const pts = track.filteredPoints;
        const segments = track.segments;
        const color = track.color;

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
              `<strong>${track.label} — ${track.displayLabel || track.vehicleId}</strong><br>${formatDateTime(
                p.timestampiso,
              )}<br>Lat ${formatNum(p.lat, 6)}<br>Lng ${formatNum(
                p.lng,
                6,
              )}<br>Speed ${this.formatSpeed(p.speed)}<br>Acc ${this.formatAccuracy(
                p.accuracy,
              )}<br>ระยะจุดนี้ ${p.segmentMeters != null ? p.segmentMeters.toFixed(2) : "-"} m`,
            );

          pointLayers.push(marker);
          return;
        }

        segments.forEach((segment, segIndex) => {
          if (!segment.length) return;

          if (segment.length >= 2) {
            polyCount += 1;
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
              `<strong>${track.label} — ${track.displayLabel || track.vehicleId}</strong><br>เริ่มช่วง ${segIndex + 1
              }<br>${formatDateTime(start.timestampiso)}`,
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
              `<strong>${track.label} — ${track.displayLabel || track.vehicleId}</strong><br>สิ้นสุดช่วง ${segIndex + 1
              }<br>${formatDateTime(end.timestampiso)}<br>ระยะจุดนี้ ${end.segmentMeters != null ? end.segmentMeters.toFixed(2) : "-"
              } m`,
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
                `<strong>${track.label} — ${track.displayLabel || track.vehicleId}</strong><br>${formatDateTime(
                  p.timestampiso,
                )}<br>Lat ${formatNum(p.lat, 6)}<br>Lng ${formatNum(
                  p.lng,
                  6,
                )}<br>Speed ${this.formatSpeed(p.speed)}<br>Acc ${this.formatAccuracy(
                  p.accuracy,
                )}<br>ระยะจุดนี้ ${p.segmentMeters != null ? p.segmentMeters.toFixed(2) : "-"} m`,
              );

            pointLayers.push(marker);
          });
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

      const popup = L.popup().setLatLng([row.lat, row.lng]).setContent(
        `<strong>${row.label} — ${row.vehicleId}</strong><br/><strong>${formatDateTime(
          row.timestampiso,
        )}</strong><br/>Lat: ${formatNum(row.lat, 6)}<br/>Lng: ${formatNum(
          row.lng,
          6,
        )}<br/>Speed: ${this.formatSpeed(row.speed)}<br/>Acc: ${this.formatAccuracy(
          row.accuracy,
        )}<br/>ระยะจุดนี้: ${row.segmentMeters != null ? row.segmentMeters.toFixed(2) : "-"
        } m`,
      );

      popup.openOn(mapInstance);
    },

    exportCsv() {
      const rows = this.visibleAllFilteredPoints;
      if (!rows.length) return;

      const headers = [
        "#",
        "รถ",
        "vehicleId",
        "จุดที่",
        "เวลา",
        "Lat",
        "Lng",
        "Speed(km/h)",
        "Accuracy(m)",
        "ระยะจุดนี้ (m)",
      ];

      const csvLines = [headers.map(escapeCsv).join(",")];

      rows.forEach((p, idx) => {
        csvLines.push(
          [
            idx + 1,
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
    this.initMap();

    this.resizeHandler = () => this.resizeMap();
    window.addEventListener("resize", this.resizeHandler);

    await this.loadDeviceOptions();
    await this.loadTracks();
  },

  beforeUnmount() {
    if (this.resizeHandler) {
      window.removeEventListener("resize", this.resizeHandler);
    }

    if (mapInstance) {
      mapInstance.remove();
      mapInstance = null;
    }
  },
}).mount("#app");