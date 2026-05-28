const { createApp } = Vue;

let firebaseDb = null;
let mapInstance = null;
let mapCanvasRenderer = null;
let routeLayers = [];
let pointLayers = [];
let vehicleLayerStates = Object.create(null);
let liveRef = null;
let liveCallback = null;
let firebaseInfoRef = null;
let firebaseInfoCallback = null;

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

createApp({
  data() {
    return {
      loading: false,
      status: "กำลังรอข้อมูลรถวันนี้...",
      statusType: "info",
      gapMinutesInput: "10",
      staleMinutesInput: "10",
      vehiclesById: {},
      visibleVehicles: {},
      vehicleMappings: {},
      lastRefreshAt: null,
      mapReady: false,
      resizeHandler: null,
      renderPending: false,
      renderTimer: null,
      renderNeedsFit: false,
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
          action: "ตรวจอุปกรณ์ที่ส่งข้อมูลทุก 5 วินาที และ path locations ใน Firebase",
          latestAgeText,
          visible: true,
          signature: `no_data:${localDateKey()}`,
        };
      }

      if (latestAgeMs >= this.staleThresholdMs) {
        return {
          kind: "stale",
          tone: "warn",
          title: `ข้อมูลล่าสุดห่างเกิน ${this.staleThresholdMinutes} นาที`,
          detail: `Firebase ยังอ่านได้ปกติ แต่ไม่มีข้อมูลใหม่เข้ามา ${latestAgeText}`,
          source: "ฝั่งอุปกรณ์ / uploader / network",
          action: "ตรวจเครื่องส่งข้อมูล, สัญญาณ, และ backend ที่บันทึกเข้า Firebase",
          latestAgeText,
          visible: true,
          signature: `stale:${this.staleThresholdMinutes}:${this.latestDataTimestampMs || "none"}`,
        };
      }

      return {
        kind: "ok",
        tone: "ok",
        title: "ข้อมูลกำลังไหลปกติ",
        detail: `ข้อมูลล่าสุดเมื่อ ${latestAgeText} ที่ผ่านมา`,
        source: "Firebase + Front ปกติ",
        action: "",
        latestAgeText,
        visible: false,
        signature: "ok",
      };
    },
    alertBannerVisible() {
      const state = this.healthState;
      if (!state.visible) return false;
      return true;
    },
    alertBannerSubtitle() {
      const remaining = this.healthNotificationPausedUntil - Date.now();
      if (remaining > 0) {
        const minutes = Math.ceil(remaining / 60000);
        return `ซ่อนอยู่ จะเด้งอีกครั้งในประมาณ ${minutes} นาที`;
      }
      return "";
    },
    noDataBannerText() {
      if (!this.noDataToday) return "";
      return "วันนี้ยังไม่มีข้อมูล GPS เข้าระบบ";
    },
  },
  watch: {
    gapMinutesInput() {
      this.scheduleRenderRoute();
    },
    visibleVehicles: {
      deep: true,
      handler() {
        this.scheduleRenderRoute();
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
        group: L.layerGroup().addTo(mapInstance),
        points: [],
        lastPoint: null,
        tailPolyline: null,
        latestMarker: null,
      };
    },
    pointsMatch(a, b) {
      if (!a || !b) return false;
      if (a.key && b.key) return a.key === b.key;
      return (
        a.timestampiso === b.timestampiso &&
        a.lat === b.lat &&
        a.lng === b.lng
      );
    },
    pointsHaveSamePrefix(prevPoints, nextPoints) {
      if (!Array.isArray(prevPoints) || !Array.isArray(nextPoints)) return false;
      if (prevPoints.length > nextPoints.length) return false;

      for (let i = 0; i < prevPoints.length; i += 1) {
        if (!this.pointsMatch(prevPoints[i], nextPoints[i])) return false;
      }

      return true;
    },
    buildPointPopupContent(vehicle, point) {
      return `<strong>${vehicle.displayLabel || vehicle.vehicleId}</strong><br>${this.formatDateTime(
        point.timestampiso,
      )}<br>Lat ${formatNum(point.lat, 6)}<br>Lng ${formatNum(point.lng, 6)}<br>Speed ${this.formatSpeed(
        point.speed,
      )}<br>ACC ${this.formatAccuracy(point.accuracy)}<br>ระยะจุดนี้: ${point.segmentMeters != null ? point.segmentMeters.toFixed(2) : '-'} m<br>ระยะรวม: ${point.cumulativeKm != null ? point.cumulativeKm.toFixed(2) : '-'} km`;
    },
    addPointDot(state, vehicle, point) {
      const dot = L.circleMarker([point.lat, point.lng], {
        radius: 5,
        color: vehicle.color,
        fillColor: vehicle.color,
        fillOpacity: 0.95,
        weight: 0,
        opacity: 1,
        renderer: mapCanvasRenderer,
        interactive: true,
      })
        .addTo(state.group)
        .bindPopup(this.buildPointPopupContent(vehicle, point), {
          autoPan: true,
          closeButton: true,
        });

      dot.on("click", () => {
        try {
          dot.openPopup();
        } catch (err) {
          console.warn(err);
        }
      });

      return dot;
    },
    addPolylineSegment(state, vehicle, startPoint, endPoint) {
      const polyline = L.polyline(
        [
          [startPoint.lat, startPoint.lng],
          [endPoint.lat, endPoint.lng],
        ],
        {
          color: vehicle.color,
          weight: 5,
          opacity: 0.95,
          lineCap: "round",
          lineJoin: "round",
          smoothFactor: 1.2,
          renderer: mapCanvasRenderer,
          className: "route-polyline",
          interactive: false,
        },
      ).addTo(state.group);

      state.tailPolyline = polyline;
      return polyline;
    },
    appendPointToState(state, vehicle, point) {
      this.addPointDot(state, vehicle, point);

      if (state.lastPoint && state.lastPoint.date && point.date) {
        const gapMs = point.date.getTime() - state.lastPoint.date.getTime();
        if (gapMs > this.gapThresholdMs) {
          state.tailPolyline = null;
        } else if (!state.tailPolyline) {
          this.addPolylineSegment(state, vehicle, state.lastPoint, point);
        } else {
          state.tailPolyline.addLatLng([point.lat, point.lng]);
        }
      }

      state.lastPoint = point;
    },
    updateLatestMarker(state, vehicle, latest) {
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
    },
    syncVehicleLayer(vehicle) {
      if (!mapInstance) this.initMap();

      const vehicleId = vehicle.vehicleId;
      const nextPoints = vehicle.points || [];
      let state = vehicleLayerStates[vehicleId];

      if (!state) {
        state = vehicleLayerStates[vehicleId] = this.createVehicleLayerState();
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

        nextPoints.forEach((point) => {
          this.appendPointToState(state, vehicle, point);
        });
      } else {
        for (let i = state.points.length; i < nextPoints.length; i += 1) {
          this.appendPointToState(state, vehicle, nextPoints[i]);
        }
      }

      state.points = nextPoints.slice();
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
    startHealthMonitor() {
      this.stopHealthMonitor();
      this.healthTimer = setInterval(() => {
        this.healthPulse += 1;
        this.refreshHealthState(true);
      }, 30000);
    },
    stopHealthMonitor() {
      if (this.healthTimer) {
        clearInterval(this.healthTimer);
        this.healthTimer = null;
      }
    },
    async subscribeTodayLive() {
      if (!this.initFirebase()) return;

      this.subscribeFirebaseConnectionState();
      await this.loadVehicleMappings();

      this.loading = true;
      this.firebaseLastError = "";
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
        this.lastSnapshotAt = new Date().toISOString();

        Object.keys(this.visibleVehicles).forEach((vehicleId) => {
          if (!visibleIds.has(vehicleId)) delete this.visibleVehicles[vehicleId];
        });

        Object.keys(result).forEach((vehicleId) => {
          if (!(vehicleId in this.visibleVehicles)) this.visibleVehicles[vehicleId] = true;
        });

        this.lastRefreshAt = new Date().toISOString();
        this.scheduleRenderRoute({ fitBounds: !this.initialAutoFitDone });
        this.loading = false;

        const count = Object.keys(result).length;
        if (count) {
          this.noDataToday = false;
          this.noDataCheckedAt = new Date().toISOString();
          this.noDataNotifiedFor = "";
          this.firebaseLastError = "";
          this.setStatus(`พบรถวิ่งวันนี้ ${count} คัน`, "ok");
        } else {
          this.updateNoDataState(0);
        }

        this.refreshHealthState(true);
      };

      liveRef.on("value", liveCallback, (err) => {
        console.error(err);
        this.firebaseLastError = `โหลดข้อมูลไม่สำเร็จ: ${err.message || err}`;
        this.setStatus(this.firebaseLastError, "error");
        this.loading = false;
        this.refreshHealthState();
      });
    },
    toggleAllVehicles(show) {
      this.vehicleSummaries.forEach((v) => {
        this.visibleVehicles[v.vehicleId] = show;
      });
      this.scheduleRenderRoute();
    },
    scheduleRenderRoute({ fitBounds = false } = {}) {
      this.renderNeedsFit = this.renderNeedsFit || fitBounds;

      if (this.renderTimer) {
        clearTimeout(this.renderTimer);
      }

      this.renderPending = true;
      this.renderTimer = setTimeout(() => {
        this.renderTimer = null;
        this.renderPending = false;
        const doFit = this.renderNeedsFit;
        this.renderNeedsFit = false;
        this.renderLiveMap({ fitBounds: doFit });
      }, 80);
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
          )}<br/>Speed: ${this.formatSpeed(row.speed)}<br/>ACC: ${this.formatAccuracy(row.accuracy)}<br/>ระยะจุดนี้: ${
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
    this.startHealthMonitor();
    this.subscribeTodayLive();
  },
  beforeUnmount() {
    this.stopHealthMonitor();
    this.detachLiveListener();
    this.detachFirebaseInfoListener();
    if (this.resizeHandler) window.removeEventListener("resize", this.resizeHandler);
    if (mapInstance) {
      mapInstance.remove();
      mapInstance = null;
    }
  },
}).mount("#app");