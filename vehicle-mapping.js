const { createApp } = Vue;

let firebaseDb = null;
let firebaseInfoRef = null;
let firebaseInfoCallback = null;

function pad(n) {
  return String(Math.abs(Number(n) || 0)).padStart(2, "0");
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

function formatDateTime(value) {
  const d = toDateSafe(value);
  if (!d) return "-";
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function syncFirebaseBadge(connected, message) {
  if (window.setFirebaseNavStatus) {
    window.setFirebaseNavStatus(connected, message);
  }
}

createApp({
  data() {
    return {
      loading: false,
      saving: false,
      status: "พร้อมใช้งาน",
      statusType: "info",
      deviceOptions: [],
      mappings: [],
      search: "",
      editing: false,
      form: {
        vehicleId: "",
        plate: "",
        note: "",
      },
    };
  },

  computed: {
    filteredMappings() {
      const q = this.search.trim().toLowerCase();
      const rows = this.mappings.slice();

      if (!q) return rows;

      return rows.filter((row) => {
        return (
          String(row.vehicleId || "").toLowerCase().includes(q) ||
          String(row.plate || "").toLowerCase().includes(q) ||
          String(row.note || "").toLowerCase().includes(q)
        );
      });
    },
  },

  methods: {
    formatDateTime(value) {
      return formatDateTime(value);
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

    initFirebase() {
      if (!window.firebaseConfig || !window.firebaseConfig.apiKey) {
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

    async loadDevices() {
      const snap = await firebaseDb.ref("locations").once("value");
      const ids = [];
      snap.forEach((child) => {
        const id = String(child.key || "").trim();
        if (id) ids.push(id);
      });
      ids.sort((a, b) => a.localeCompare(b, "th", { numeric: true, sensitivity: "base" }));
      this.deviceOptions = ids;
    },

    async loadMappings() {
      const snap = await firebaseDb.ref("vehicle_mappings").once("value");
      const items = [];

      snap.forEach((child) => {
        const value = child.val() || {};
        const vehicleId = String(child.key || value.vehicle_id || "").trim();
        if (!vehicleId) return;

        items.push({
          vehicleId,
          plate: String(value.plate || value.license_plate || "").trim(),
          note: String(value.note || "").trim(),
          updatedAt: value.updatedAt || value.updated_at || null,
        });
      });

      items.sort((a, b) => a.vehicleId.localeCompare(b.vehicleId, "th", { numeric: true, sensitivity: "base" }));
      this.mappings = items;
    },

    async reloadAll() {
      if (!this.initFirebase()) return;

      this.loading = true;
      this.setStatus("กำลังโหลดข้อมูล...", "info");

      try {
        await Promise.all([this.loadDevices(), this.loadMappings()]);
        this.setStatus(`โหลดข้อมูลสำเร็จ ${this.mappings.length} รายการ`, "ok");
      } catch (err) {
        console.error(err);
        this.setStatus(`โหลดข้อมูลไม่สำเร็จ: ${err.message || err}`, "error");
      } finally {
        this.loading = false;
      }
    },

    resetForm() {
      this.form = {
        vehicleId: "",
        plate: "",
        note: "",
      };
      this.editing = false;
    },

    editMapping(row) {
      this.form.vehicleId = row.vehicleId;
      this.form.plate = row.plate || "";
      this.form.note = row.note || "";
      this.editing = true;
      this.setStatus(`กำลังแก้ไข ${row.vehicleId}`, "info");
    },

    async saveMapping() {
      if (!this.initFirebase()) return;

      const vehicleId = String(this.form.vehicleId || "").trim();
      const plate = String(this.form.plate || "").trim();
      const note = String(this.form.note || "").trim();

      if (!vehicleId) {
        this.setStatus("กรุณากรอก vehicle_id", "warn");
        return;
      }

      if (!plate) {
        this.setStatus("กรุณากรอกทะเบียนรถ", "warn");
        return;
      }

      this.saving = true;
      this.setStatus("กำลังบันทึกข้อมูล...", "info");

      try {
        await firebaseDb.ref(`vehicle_mappings/${vehicleId}`).set({
          vehicle_id: vehicleId,
          plate,
          note,
          updatedAt: new Date().toISOString(),
        });

        await this.loadMappings();
        this.setStatus(`บันทึกจับคู่รถ ${vehicleId} = ${plate} เรียบร้อย`, "ok");
        this.resetForm();
      } catch (err) {
        console.error(err);
        this.setStatus(`บันทึกไม่สำเร็จ: ${err.message || err}`, "error");
      } finally {
        this.saving = false;
      }
    },

    async deleteMapping(vehicleId) {
      if (!this.initFirebase()) return;

      if (!window.confirm(`ต้องการลบการจับคู่ของ ${vehicleId} ใช่หรือไม่`)) return;

      this.saving = true;
      this.setStatus(`กำลังลบ ${vehicleId}...`, "info");

      try {
        await firebaseDb.ref(`vehicle_mappings/${vehicleId}`).remove();
        await this.loadMappings();
        if (this.form.vehicleId === vehicleId) this.resetForm();
        this.setStatus(`ลบการจับคู่ ${vehicleId} แล้ว`, "ok");
      } catch (err) {
        console.error(err);
        this.setStatus(`ลบไม่สำเร็จ: ${err.message || err}`, "error");
      } finally {
        this.saving = false;
      }
    },
  },

  mounted() {
    this.subscribeFirebaseConnectionState();
    this.reloadAll();
  },

  beforeUnmount() {
    if (firebaseInfoRef && firebaseInfoCallback) {
      try {
        firebaseInfoRef.off("value", firebaseInfoCallback);
      } catch (err) {
        console.warn(err);
      }
    }
  },
}).mount("#app");
