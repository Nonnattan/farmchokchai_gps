const { createApp } = Vue;

let firebaseDb = null;
let mapInstance = null;
let routeLayers = [];
let pointLayers = [];

function formatNum(n, digits = 6) {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) : "-";
}

function formatInt(n) {
  return typeof n === "number" && Number.isFinite(n) ? String(Math.round(n)) : "-";
}

function toDateSafe(value) {
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
  if (/[\",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function initNavbar() {
  const currentPage = location.pathname.split("/").pop() || "index.html";
  document.querySelectorAll(".nav-link").forEach((link) => {
    if (link.getAttribute("href") === currentPage) {
      link.classList.add("active");
    }
  });

  const toggle = document.querySelector(".nav-toggle");
  const menu = document.querySelector(".nav-menu");

  if (toggle && menu) {
    const setExpanded = (expanded) => {
      toggle.setAttribute("aria-expanded", String(expanded));
      menu.classList.toggle("open", expanded);
    };

    toggle.setAttribute("aria-expanded", "false");

    toggle.addEventListener("click", () => {
      const open = menu.classList.contains("open");
      setExpanded(!open);
    });

    document.querySelectorAll(".nav-menu .nav-link").forEach((link) => {
      link.addEventListener("click", () => {
        setExpanded(false);
      });
    });

    window.addEventListener("resize", () => {
      if (window.innerWidth > 640) {
        setExpanded(false);
      }
    });
  }
}

initNavbar();

createApp({
  data() {
    return {
      vehicleId1: "GPS_01",
      vehicleId2: "GPS_02",
      fromDate: "",
      toDate: "",
      gapMinutesInput: "10",
      showTable: true,
      showVehicle1: true,
      showVehicle2: true,

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
      },

      loading: false,
      status: "พร้อมใช้งาน",
      statusType: "info",
      mapReady: false,
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

    selectedDateRangeText() {
      const from = this.fromDate || "-";
      const to = this.toDate || "-";
      return `${from} ถึง ${to}`;
    },

    vehicleConfigs() {
      const configs = [
        {
          slot: "v1",
          label: "คันที่ 1",
          inputId: this.vehicleId1,
          color: "#38bdf8",
        },
      ];

      if (String(this.vehicleId2 || "").trim()) {
        configs.push({
          slot: "v2",
          label: "คันที่ 2",
          inputId: this.vehicleId2,
          color: "#f59e0b",
        });
      }

      return configs.map((cfg) => ({
        ...cfg,
        vehicleId: this.sanitizeVehicleId(cfg.inputId),
      }));
    },

    trackSummaries() {
      return this.vehicleConfigs.map((cfg) => {
        const rawPoints = this.tracks[cfg.slot]?.points || [];
        const filteredPoints = this.getFilteredPoints(rawPoints);
        const segments = this.buildSegments(filteredPoints);
        const distanceKm = this.distanceKmFromSegments(segments);
        const activeSegments = segments.filter((s) => s.length >= 2).length;

        return {
          ...cfg,
          pointCount: filteredPoints.length,
          segmentCount: activeSegments,
          distanceKm,
          distanceText:
            filteredPoints.length >= 2 ? `${distanceKm.toFixed(2)} km` : "0.00 km",
          firstText: filteredPoints[0]?.timestampiso || "-",
          lastText: filteredPoints[filteredPoints.length - 1]?.timestampiso || "-",
          lastUpdatedAt: this.tracks[cfg.slot]?.lastUpdatedAt || null,
          status: this.tracks[cfg.slot]?.status || "-",
          statusType: this.tracks[cfg.slot]?.statusType || "info",
          filteredPoints,
          segments,
        };
      });
    },

    visibleTrackSummaries() {
      return this.trackSummaries.filter((track) => {
        if (track.slot === "v1") return this.showVehicle1;
        if (track.slot === "v2") return this.showVehicle2;
        return true;
      });
    },

    visibleAllFilteredPoints() {
      const rows = [];

      for (const track of this.visibleTrackSummaries) {
        track.filteredPoints.forEach((p, idx) => {
          rows.push({
            ...p,
            slot: track.slot,
            label: track.label,
            vehicleId: track.vehicleId,
            color: track.color,
            indexInTrack: idx,
          });
        });
      }

      rows.sort((a, b) => {
        const ta = a.date ? a.date.getTime() : 0;
        const tb = b.date ? b.date.getTime() : 0;
        return ta - tb;
      });

      return rows;
    },

    totalDistanceKm() {
      return this.visibleTrackSummaries.reduce((sum, track) => sum + track.distanceKm, 0);
    },

    totalDistanceText() {
      return this.visibleAllFilteredPoints.length >= 2
        ? `${this.totalDistanceKm.toFixed(2)} km`
        : "0.00 km";
    },

    lastUpdatedText() {
      const times = this.visibleTrackSummaries.map((t) => t.lastUpdatedAt).filter(Boolean);

      if (!times.length) return "-";
      return times.sort().slice(-1)[0];
    },
  },

  watch: {
    fromDate() { this.renderRoute(); },
    toDate() { this.renderRoute(); },
    gapMinutesInput() { this.renderRoute(); },
    showVehicle1() { this.renderRoute(); },
    showVehicle2() { this.renderRoute(); },
  },

  methods: {
    setStatus(text, type = "info") {
      this.status = text;
      this.statusType = type;
    },

    sanitizeVehicleId(value) {
      return (
        String(value || "")
          .trim()
          .replace(/[.#$/\[\]\\s]+/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "") || "demo-vehicle"
      );
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
        if (!firebase.apps.length) {
          firebase.initializeApp(window.firebaseConfig);
        }

        if (!firebaseDb) {
          firebaseDb = firebase.database();
        }

        return true;
      } catch (err) {
        console.error(err);
        this.setStatus(`เริ่ม Firebase ไม่สำเร็จ: ${err.message || err}`, "error");
        return false;
      }
    },

    initMap() {
      if (mapInstance) return;

      mapInstance = L.map("map", { zoomControl: true }).setView([13.736717, 100.523186], 6);

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
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
          sum += haversineMeters(seg[i - 1].lat, seg[i - 1].lng, seg[i].lat, seg[i].lng);
        }
      }

      return sum / 1000;
    },

    fitToRoute() {
      if (!mapInstance || !this.visibleAllFilteredPoints.length) return;

      const latlngs = this.visibleAllFilteredPoints.map((p) => [p.lat, p.lng]);
      const bounds = L.latLngBounds(latlngs);

      if (bounds.isValid()) {
        mapInstance.fitBounds(bounds.pad(0.15));
      }
    },

    focusPoint(row) {
      if (!row || !mapInstance) return;

      mapInstance.setView([row.lat, row.lng], Math.max(mapInstance.getZoom(), 16));

      const popup = L.popup()
        .setLatLng([row.lat, row.lng])
        .setContent(
          `<strong>${row.label} — ${row.vehicleId}</strong><br/><strong>${row.timestampiso}</strong><br/>Lat: ${formatNum(row.lat, 6)}<br/>Lng: ${formatNum(row.lng, 6)}<br/>Speed: ${this.formatSpeed(row.speed)}<br/>Acc: ${this.formatAccuracy(row.accuracy)}`,
        );

      popup.openOn(mapInstance);
    },

    formatCoord(value) { return formatNum(value, 6); },

    formatSpeed(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "-";
      const kmh = value * 3.6;
      return `${kmh.toFixed(1)} km/h`;
    },

    formatAccuracy(value) {
      return typeof value === "number" && Number.isFinite(value)
        ? `${formatInt(value)} m`
        : "-";
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

        items.push({
          key: child.key,
          lat,
          lng,
          speed: Number.isFinite(Number(value.speed)) ? Number(value.speed) : null,
          accuracy: Number.isFinite(Number(value.accuracy)) ? Number(value.accuracy) : null,
          timestampiso,
          date,
          raw: value,
        });
      });

      items.sort((a, b) => {
        const ta = a.date ? a.date.getTime() : 0;
        const tb = b.date ? b.date.getTime() : 0;
        return ta - tb;
      });

      return items;
    },

    setTrackData(slot, points) {
      this.tracks[slot].points = points;
      this.tracks[slot].lastUpdatedAt = new Date().toLocaleString("th-TH");
      this.tracks[slot].status = points.length ? `โหลดแล้ว ${points.length} จุด` : "ไม่พบข้อมูล";
      this.tracks[slot].statusType = points.length ? "ok" : "warn";
    },

    renderRoute() {
      this.resetMapLayers();

      if (!mapInstance) this.initMap();

      const summaries = this.visibleTrackSummaries;
      const totalPoints = summaries.reduce((sum, track) => sum + track.filteredPoints.length, 0);

      if (!totalPoints) {
        this.setStatus("ไม่พบข้อมูลในช่วงวันที่/รถที่เลือก", "warn");
        return;
      }

      let polyCount = 0;

      summaries.forEach((track) => {
        const { filteredPoints: pts, segments, color } = track;

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
              `<strong>${track.label} — ${track.vehicleId}</strong><br>${p.timestampiso}<br>Lat ${formatNum(p.lat, 6)}<br>Lng ${formatNum(p.lng, 6)}`,
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
              `${track.label} — ${track.vehicleId}<br>เริ่มช่วง ${segIndex + 1}<br>${start.timestampiso}`,
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
              `${track.label} — ${track.vehicleId}<br>สิ้นสุดช่วง ${segIndex + 1}<br>${end.timestampiso}`,
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
                `<strong>${track.label} — ${track.vehicleId}</strong><br>${p.timestampiso}<br>Lat ${formatNum(p.lat, 6)}<br>Lng ${formatNum(p.lng, 6)}<br>Speed ${this.formatSpeed(p.speed)}<br>Acc ${this.formatAccuracy(p.accuracy)}`,
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

      if (summaries.length > 1) {
        this.setStatus(`โหลดข้อมูลรวม ${totalPoints} จุด และแยกเป็น ${polyCount} ช่วง`, "ok");
      } else {
        this.setStatus(`โหลดข้อมูล ${totalPoints} จุดแล้ว`, "ok");
      }
    },

    async loadTracks() {
      if (!this.initFirebase()) return;

      const configs = this.vehicleConfigs;

      if (!configs.length) {
        this.setStatus("กรุณากรอก Vehicle ID อย่างน้อย 1 คัน", "warn");
        return;
      }

      this.loading = true;
      this.setStatus("กำลังดึงข้อมูล...", "info");

      try {
        const results = await Promise.all(
          configs.map(async (cfg) => {
            const snapshot = await firebaseDb.ref(`locations/${cfg.vehicleId}`).orderByKey().once("value");
            return {
              slot: cfg.slot,
              points: this.parseSnapshot(snapshot),
            };
          }),
        );

        results.forEach((r) => {
          this.setTrackData(r.slot, r.points);
        });

        this.renderRoute();
      } catch (err) {
        console.error(err);
        this.setStatus(`โหลดข้อมูลไม่สำเร็จ: ${err.message || err}`, "error");
      } finally {
        this.loading = false;
      }
    },

    exportCsv() {
      const rows = this.visibleAllFilteredPoints;
      if (!rows.length) return;

      const headers = [
        "ลำดับ",
        "รถ",
        "vehicleId",
        "เวลา",
        "Lat",
        "Lng",
        "Speed(m/s)",
        "Speed(km/h)",
        "Accuracy(m)",
      ];

      const csvLines = [headers.map(escapeCsv).join(",")];

      rows.forEach((p, idx) => {
        csvLines.push(
          [
            idx + 1,
            p.label,
            p.vehicleId,
            p.timestampiso,
            p.lat,
            p.lng,
            p.speed ?? "",
            typeof p.speed === "number" && Number.isFinite(p.speed) ? (p.speed * 3.6).toFixed(1) : "",
            p.accuracy ?? "",
          ]
            .map(escapeCsv)
            .join(","),
        );
      });

      const blob = new Blob(["﻿" + csvLines.join("\n")], { type: "text/csv;charset=utf-8;" });
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
      this.tracks.v1.points = [];
      this.tracks.v1.lastUpdatedAt = null;
      this.tracks.v1.status = "ยังไม่ได้โหลด";
      this.tracks.v1.statusType = "info";

      this.tracks.v2.points = [];
      this.tracks.v2.lastUpdatedAt = null;
      this.tracks.v2.status = "ยังไม่ได้โหลด";
      this.tracks.v2.statusType = "info";

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

  mounted() {
    this.initMap();

    this.resizeHandler = () => this.resizeMap();
    window.addEventListener("resize", this.resizeHandler);

    this.loadTracks();
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
