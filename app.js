const { createApp } = Vue;

// เก็บ instance ของ Firebase ไว้นอก Vue เพื่อไม่ให้ถูก proxy
let firebaseDb = null;

// เก็บ Wake Lock sentinel ไว้นอก Vue
let wakeLock = null;

const currentPage = location.pathname.split("/").pop() || "index.html";
document.querySelectorAll(".nav-link").forEach((link) => {
  const href = link.getAttribute("href");
  if (href === currentPage) {
    link.classList.add("active");
  }
});
function pad(n) {
  return String(Math.abs(n)).padStart(2, "0");
}

function toIsoWithOffset(date = new Date()) {
  const tz = -date.getTimezoneOffset();
  const sign = tz >= 0 ? "+" : "-";
  const hh = pad(Math.floor(Math.abs(tz) / 60));
  const mm = pad(Math.abs(tz) % 60);

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${hh}:${mm}`
  );
}

function formatNum(n, digits = 6) {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) : "-";
}

function formatInt(n) {
  return typeof n === "number" && Number.isFinite(n) ? String(Math.round(n)) : "-";
}

function parsePositiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

createApp({
  data() {
    return {
      tracking: false,
      watchId: null,

      lastSentAt: 0,

      lat: null,
      lng: null,
      speed: null,
      accuracy: null,
      timestampiso: null,

      gpsReady: false,
      wakeLockSupported: "wakeLock" in navigator,
      wakeLockActive: false,

      // เก็บเป็น string เพื่อพิมพ์แล้วไม่เด้งกลับ
      minAccuracyMetersInput: "50",
      uploadIntervalMsInput: "10000",

      status: "พร้อมใช้งาน",
      statusType: "info",

      vehicleId: "GPS_01",
      lastPayload: null,
      debugLines: []
    };
  },

  computed: {
    minAccuracyMeters() {
      return parsePositiveNumber(this.minAccuracyMetersInput, 50);
    },
    uploadIntervalMs() {
      return parsePositiveNumber(this.uploadIntervalMsInput, 10000);
    },
    latText() {
      return formatNum(this.lat, 6);
    },
    lngText() {
      return formatNum(this.lng, 6);
    },
    speedText() {
      return typeof this.speed === "number" ? `${Math.round(this.speed)} m/s` : "-";
    },
    accuracyText() {
      return typeof this.accuracy === "number"
        ? `${this.accuracy.toFixed(0)} m`
        : "-";
    },
    timestampText() {
      return this.timestampiso || "-";
    },
    lastPayloadText() {
      return this.lastPayload ? JSON.stringify(this.lastPayload, null, 2) : "-";
    },
    debugLog() {
      return this.debugLines.join("\n");
    }
  },

  methods: {
    log(message) {
      const line = `[${new Date().toLocaleTimeString()}] ${message}`;
      this.debugLines.unshift(line);
      this.debugLines = this.debugLines.slice(0, 15);
    },

    setStatus(text, type = "info") {
      this.status = text;
      this.statusType = type;
      this.log(text);
    },

    clearLogs() {
      this.lastPayload = null;
      this.debugLines = [];
      this.setStatus("ล้างข้อมูลล่าสุดและ Debug Log แล้ว", "info");
    },

    sanitizeVehicleId(value) {
      return (
        String(value || "")
          .trim()
          .replace(/[.#$/\[\]\\\s]+/g, "-")
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

    async requestWakeLock() {
      if (!this.wakeLockSupported) {
        this.wakeLockActive = false;
        return false;
      }

      try {
        if (wakeLock) {
          return true;
        }

        wakeLock = await navigator.wakeLock.request("screen");
        this.wakeLockActive = true;
        this.log("เปิด Wake Lock แล้ว");

        wakeLock.addEventListener("release", () => {
          this.wakeLockActive = false;
          wakeLock = null;
          this.log("Wake Lock ถูกปล่อย");
        });

        return true;
      } catch (err) {
        console.warn(err);
        this.wakeLockActive = false;
        this.log(`ขอ Wake Lock ไม่สำเร็จ: ${err.message || err}`);
        return false;
      }
    },

    async reRequestWakeLockIfNeeded() {
      if (!this.tracking) return;
      if (!this.wakeLockSupported) return;

      if (document.visibilityState === "visible") {
        await this.requestWakeLock();
      }
    },

    async releaseWakeLock() {
      try {
        if (wakeLock) {
          await wakeLock.release();
          wakeLock = null;
        }
      } catch (err) {
        console.warn(err);
      } finally {
        this.wakeLockActive = false;
      }
    },

    shouldSendNow() {
      if (this.uploadIntervalMs <= 0) return true;
      const now = Date.now();
      return now - this.lastSentAt >= this.uploadIntervalMs;
    },

    async saveLocation(pos) {
      try {
        const coords = pos.coords;
        const nowMs = pos.timestamp || Date.now();
        const readingTime = new Date(nowMs);

        const latitude = coords.latitude;
        const longitude = coords.longitude;
        const accuracy =
          typeof coords.accuracy === "number" ? coords.accuracy : null;
        const speedValue =
          typeof coords.speed === "number" ? Math.round(coords.speed) : null;

        this.lat = latitude;
        this.lng = longitude;
        this.speed = speedValue;
        this.accuracy = accuracy;
        this.timestampiso = toIsoWithOffset(readingTime);

        if (!this.gpsReady) {
          this.gpsReady = true;
          this.setStatus("ได้ GPS fix ครั้งแรกแล้ว กำลังพร้อมบันทึก...", "ok");
        }

        if (!this.initFirebase()) return;

        // บล็อคเมื่อ accuracy ไม่ถึงค่า
        // เช่น 50 => ต้อง < 50 ถึงจะเก็บ
        if (typeof accuracy !== "number") {
          this.lastPayload = {
            vehicle_id: this.sanitizeVehicleId(this.vehicleId),
            lat: latitude,
            lng: longitude,
            speed: speedValue,
            accuracy: null,
            timestampiso: this.timestampiso,
            blocked: true,
            reason: "ไม่มีค่า accuracy จากอุปกรณ์"
          };
          this.setStatus("ยังไม่มีค่า accuracy จึงยังไม่บันทึก", "warn");
          return;
        }

        if (accuracy >= this.minAccuracyMeters) {
          this.lastPayload = {
            vehicle_id: this.sanitizeVehicleId(this.vehicleId),
            lat: latitude,
            lng: longitude,
            speed: speedValue,
            accuracy,
            timestampiso: this.timestampiso,
            blocked: true,
            reason: `accuracy ${accuracy.toFixed(0)}m >= ${this.minAccuracyMeters}m`
          };
          this.setStatus(
            `accuracy ${accuracy.toFixed(0)}m ยังไม่ถึงเกณฑ์ ต้องน้อยกว่า ${this.minAccuracyMeters}m`,
            "warn"
          );
          return;
        }

        if (!this.shouldSendNow()) {
          this.lastPayload = {
            vehicle_id: this.sanitizeVehicleId(this.vehicleId),
            lat: latitude,
            lng: longitude,
            speed: speedValue,
            accuracy,
            timestampiso: this.timestampiso,
            skipped: true,
            reason: `รอครบ ${this.uploadIntervalMs}ms`
          };
          return;
        }

        const vehicle_id = this.sanitizeVehicleId(this.vehicleId);
        const timestampKey = this.timestampiso;

        const payload = {
          vehicle_id,
          lat: latitude,
          lng: longitude,
          speed: speedValue,
          accuracy,
          timestampiso: this.timestampiso
        };

        this.lastPayload = payload;

        const ref = firebaseDb.ref(`locations/${vehicle_id}/${timestampKey}`);
        await ref.set(payload);

        this.lastSentAt = Date.now();
        this.setStatus(`บันทึกข้อมูลของทะเบียน ${vehicle_id} ลง Firebase แล้ว`, "ok");
      } catch (err) {
        console.error(err);
        this.setStatus(`บันทึก Firebase ไม่สำเร็จ: ${err.message || err}`, "error");
      }
    },

    handleError(err) {
      const map = {
        1: "ผู้ใช้ไม่อนุญาตให้เข้าถึง GPS",
        2: "หาตำแหน่งไม่พบ",
        3: "รอนานเกินไป"
      };
      this.setStatus(map[err.code] || err.message || "เกิดข้อผิดพลาด", "error");
    },

    async startTracking() {
      if (!("geolocation" in navigator)) {
        this.setStatus("เบราว์เซอร์นี้ไม่รองรับ Geolocation", "error");
        return;
      }

      if (!this.initFirebase()) return;

      this.tracking = true;
      this.gpsReady = false;
      this.setStatus("กำลังขอสิทธิ์ GPS...", "info");

      await this.requestWakeLock();

      const options = {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 20000
      };

      this.watchId = navigator.geolocation.watchPosition(
        (pos) => this.saveLocation(pos),
        (err) => this.handleError(err),
        options
      );
    },

    async stopTracking() {
      if (this.watchId !== null) {
        navigator.geolocation.clearWatch(this.watchId);
        this.watchId = null;
      }
      this.tracking = false;
      await this.releaseWakeLock();
      this.setStatus("หยุดติดตามแล้ว", "info");
    },

    async testWrite() {
      try {
        if (!this.initFirebase()) return;

        const vehicle_id = this.sanitizeVehicleId(this.vehicleId);
        const timestampiso = toIsoWithOffset(new Date());

        const payload = {
          vehicle_id,
          lat: null,
          lng: null,
          speed: null,
          accuracy: null,
          timestampiso
        };

        await firebaseDb.ref(`locations/${vehicle_id}/${timestampiso}`).set(payload);

        this.lastPayload = payload;
        this.setStatus(`ทดสอบเขียนข้อมูลของทะเบียน ${vehicle_id} สำเร็จ`, "ok");
      } catch (err) {
        console.error(err);
        this.setStatus(`ทดสอบเขียน DB ไม่สำเร็จ: ${err.message || err}`, "error");
      }
    }
  },

  mounted() {
    this.beforeUnloadHandler = () => this.stopTracking();

    this.visibilityHandler = () => {
      if (document.visibilityState === "visible") {
        this.reRequestWakeLockIfNeeded();
      }
    };

    window.addEventListener("beforeunload", this.beforeUnloadHandler);
    document.addEventListener("visibilitychange", this.visibilityHandler);
  },

  beforeUnmount() {
    this.stopTracking();

    if (this.beforeUnloadHandler) {
      window.removeEventListener("beforeunload", this.beforeUnloadHandler);
    }

    if (this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
    }
  }
}).mount("#app");