const { createApp, markRaw } = Vue;
const FQ = window.FirebaseQueries;

let firebaseDb = null;
let firebaseInfoRef = null;
let firebaseInfoCallback = null;

// ---- การดึงข้อมูลแบบตามช่วง (ไม่อ่าน locations ทั้งก้อน) ----
const AUTO_REFRESH_MS = 60000; // auto refresh เฉพาะโหมด "วันนี้" ทุก 60 วิ
const FILTER_DEBOUNCE_MS = 400;
const MAX_CACHED_PERIODS = 6;
// periodCache: prefix ("YYYY-MM-DD" | "YYYY-MM" | "YYYY") -> { complete, vehicles: Map(vehicleId -> { rows, lastKey }) }
// complete = ช่วงนี้ปิดไปแล้วตอนดึง (อดีต) จึงไม่ต้อง refresh อีก
const periodCache = new Map();
let requestSeq = 0; // เลขลำดับ request ใช้ทิ้งผลของ request เก่า
let inFlight = false; // in-flight guard ของ auto refresh
let filterDebounceTimer = null;
let visibilityHandler = null;
let lastVehicleListing = null;

function isClosedPeriodPrefix(prefix) {
  const todayKey = todayISODate();
  return prefix < todayKey.slice(0, prefix.length);
}

function rowFromChild(child) {
  const value = child.val() || {};
  const lat = Number(value.lat);
  const lng = Number(value.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const timestampiso = String(value.timestampiso || child.key || '');
  const date = toDateSafe(timestampiso);
  if (!date) return null;

  return { key: child.key, lat, lng, timestampiso, date };
}

function rowsFromSnapshot(snapshot, skipKey = null) {
  const rows = [];
  snapshot.forEach((child) => {
    if (skipKey && child.key === skipKey) return;
    const row = rowFromChild(child);
    if (row) rows.push(row);
  });
  return rows;
}

function rememberPeriod(prefix, entry) {
  periodCache.delete(prefix);
  periodCache.set(prefix, entry);
  while (periodCache.size > MAX_CACHED_PERIODS) {
    const oldest = periodCache.keys().next().value;
    periodCache.delete(oldest);
  }
}

const COLORS = [
  '#38bdf8',
  '#f59e0b',
  '#22c55e',
  '#a855f7',
  '#ef4444',
  '#14b8a6',
  '#eab308',
  '#f97316',
  '#06b6d4',
  '#8b5cf6',
  '#84cc16',
  '#ec4899',
];

function pad(n) {
  return String(Math.abs(Number(n) || 0)).padStart(2, '0');
}

function todayISODate() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayMonthISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function toDateSafe(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'object') {
    if (typeof value.toDate === 'function') {
      const d = value.toDate();
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
    }
    if (typeof value.seconds === 'number') {
      const ms =
        value.seconds * 1000 +
        (typeof value.nanoseconds === 'number' ? value.nanoseconds / 1e6 : 0);
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d;
    }
  }

  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function sameCalendarDay(a, b) {
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

function colorForId(vehicleId) {
  let hash = 0;
  for (let i = 0; i < vehicleId.length; i += 1) {
    hash = (hash * 31 + vehicleId.charCodeAt(i)) >>> 0;
  }
  return COLORS[hash % COLORS.length];
}

function formatDateTime(value) {
  const d = toDateSafe(value);
  if (!d) return '-';
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDistanceKm(value) {
  if (!Number.isFinite(value)) return '-';
  return `${value.toFixed(2)} km`;
}


function formatDistanceAxis(value) {
  if (!Number.isFinite(value)) return '-';
  if (value >= 100) return `${Math.round(value)}`;
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function splitLabelLines(text, maxLineLength = 12) {
  const raw = String(text || '').trim();
  if (!raw) return ['-'];
  if (raw.length <= maxLineLength) return [raw];

  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    return [raw.slice(0, Math.max(1, maxLineLength - 1)) + '…'];
  }

  const lines = [];
  let current = '';
  words.forEach((word) => {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxLineLength || !current) {
      current = next;
    } else {
      lines.push(current);
      current = word;
    }
  });
  if (current) lines.push(current);

  if (lines.length <= 2) return lines;
  const first = lines[0];
  const second = lines.slice(1).join(' ');
  if (second.length <= maxLineLength) return [first, second];
  return [first, second.slice(0, Math.max(1, maxLineLength - 1)) + '…'];
}

function isSuspiciousJump(prev, curr, maxSpeedKmh = 180) {
  if (!prev || !curr || !prev.date || !curr.date) return null;

  const timeMs = curr.date.getTime() - prev.date.getTime();
  if (!Number.isFinite(timeMs) || timeMs <= 0) {
    return { suspicious: true, reason: 'เวลาไม่เรียงหรือซ้ำกับจุดก่อนหน้า' };
  }

  const distanceMeters = haversineMeters(prev.lat, prev.lng, curr.lat, curr.lng);
  const hours = timeMs / 3600000;
  const impliedSpeed = hours > 0 ? (distanceMeters / 1000) / hours : Infinity;

  if (!Number.isFinite(distanceMeters) || !Number.isFinite(impliedSpeed)) {
    return { suspicious: true, reason: 'คำนวณระยะทางไม่ได้' };
  }

  if (impliedSpeed > maxSpeedKmh) {
    return {
      suspicious: true,
      reason: `กระโดด ${distanceMeters.toFixed(0)} m ใน ${(timeMs / 60000).toFixed(1)} นาที`,
    };
  }

  return null;
}

createApp({
  data() {
    return {
      loading: false,
      status: 'พร้อมใช้งาน',
      statusType: 'info',
      refreshTimer: null,
      lastUpdatedAt: null,
      totalPointCount: 0,
      totalDistanceKmAll: 0,
      liveByVehicle: {},
      mappingsByVehicle: {},
      filterMode: 'day',
      filterDate: todayISODate(),
      filterMonth: todayMonthISO(),
      filterYear: String(new Date().getFullYear()),
    };
  },

  computed: {
    selectedPeriodText() {
      if (this.filterMode === 'day') return `วันที่ ${this.filterDate || '-'}`;
      if (this.filterMode === 'month') return `เดือน ${this.filterMonth || '-'}`;
      if (this.filterMode === 'year') return `ปี ${this.filterYear || '-'}`;
      return '-';
    },

    liveVehicles() {
      const entries = Object.entries(this.liveByVehicle).map(([vehicleId, data]) => {
        const color = colorForId(vehicleId);
        const points = data.points || [];
        const latest = points.length ? points[points.length - 1] : null;
        const distanceKm = data.distanceKm || 0;
        return {
          vehicleId,
          color,
          points,
          latest,
          latestTime: latest?.date ? latest.date.getTime() : 0,
          pointCount: points.length,
          segmentCount: data.segmentCount || 0,
          distanceKm,
          distanceText: formatDistanceKm(distanceKm),
          plateText: this.getPlateText(vehicleId),
        };
      });

      entries.sort(
        (a, b) => b.distanceKm - a.distanceKm || b.latestTime - a.latestTime || a.vehicleId.localeCompare(b.vehicleId, 'th'),
      );
      return entries;
    },

    mappingRows() {
      return Object.entries(this.mappingsByVehicle)
        .map(([vehicleId, data]) => ({
          vehicleId,
          plate: data.plate || '',
          note: data.note || '',
          updatedAt: data.updatedAt || null,
        }))
        .sort((a, b) => a.vehicleId.localeCompare(b.vehicleId, 'th'));
    },

    liveVehicleCount() {
      return String(this.liveVehicles.length);
    },

    totalPointText() {
      return String(this.totalPointCount);
    },

    totalDistanceText() {
      return formatDistanceKm(this.totalDistanceKmAll);
    },

    lastUpdatedText() {
      if (!this.lastUpdatedAt) return '-';
      return formatDateTime(this.lastUpdatedAt);
    },
    barChartVehicles() {
      return this.liveVehicles.slice();
    },

    barSvgWidth() {
      const count = Math.max(1, this.barChartVehicles.length);
      return Math.max(760, 72 + count * 88);
    },

    barSvgHeight() {
      return 360;
    },

    barChartMaxDistance() {
      return Math.max(1, ...this.barChartVehicles.map((item) => item.distanceKm || 0));
    },

    barChartTicks() {
      const max = this.barChartMaxDistance;
      const steps = [0, 0.25, 0.5, 0.75, 1];
      return steps.map((ratio) => {
        const value = max * ratio;
        return {
          value,
          label: formatDistanceAxis(value),
        };
      });
    },

    barChartBars() {
      const rows = this.barChartVehicles;
      const maxDistance = this.barChartMaxDistance;
      const plotHeight = 210;
      const baseY = 272;
      const leftPad = 56;
      const gap = 82;
      const barWidth = 42;

      return rows.map((item, index) => {
        const value = item.distanceKm || 0;
        const height = maxDistance > 0 ? Math.max(4, (value / maxDistance) * plotHeight) : 4;
        const x = leftPad + index * gap + (gap - barWidth) / 2;
        const y = baseY - height;
        const label = item.plateText !== 'ยังไม่จับคู่' ? item.plateText : item.vehicleId;
        return {
          ...item,
          x,
          y,
          barWidth,
          height,
          baseY,
          valueLabel: value.toFixed(2),
          labelLines: splitLabelLines(label, 10),
        };
      });
    },

    pieSegments() {
      const rows = this.liveVehicles.slice().sort((a, b) => b.distanceKm - a.distanceKm);
      const top = rows.slice(0, 6);
      const rest = rows.slice(6);

      const segments = top.map((item) => ({
        label: item.plateText !== 'ยังไม่จับคู่' ? item.plateText : item.vehicleId,
        value: item.distanceKm || 0,
        color: item.color,
        distanceText: item.distanceText,
      }));

      const restValue = rest.reduce((sum, item) => sum + (item.distanceKm || 0), 0);
      if (restValue > 0) {
        segments.push({
          label: 'อื่นๆ',
          value: restValue,
          color: '#94a3b8',
          distanceText: formatDistanceKm(restValue),
        });
      }

      const total = segments.reduce((sum, item) => sum + item.value, 0);
      if (total <= 0) return [];

      let running = 0;
      return segments.map((item) => {
        const percent = (item.value / total) * 100;
        const start = running;
        const end = running + percent;
        running = end;
        return {
          ...item,
          percent,
          start,
          end,
        };
      });
    },

    pieGradientStyle() {
      if (!this.pieSegments.length) return {};

      let cursor = 0;
      const stops = this.pieSegments.map((segment) => {
        const start = cursor;
        const end = cursor + segment.percent;
        cursor = end;
        return `${segment.color} ${start}% ${end}%`;
      });

      return {
        background: `conic-gradient(${stops.join(', ')})`,
      };
    },

    pieLegendRows() {
      return this.pieSegments;
    },

    barChartTitle() {
      return this.filterMode === 'day'
        ? 'กราฟแท่ง: ระยะทางรวมต่อคัน (วันที่เลือก)'
        : this.filterMode === 'month'
          ? 'กราฟแท่ง: ระยะทางรวมต่อคัน (เดือนที่เลือก)'
          : 'กราฟแท่ง: ระยะทางรวมต่อคัน (ปีที่เลือก)';
    }
  },

  watch: {
    filterMode() {
      this.scheduleFilterRefresh();
    },
    filterDate() {
      this.scheduleFilterRefresh();
    },
    filterMonth() {
      this.scheduleFilterRefresh();
    },
    filterYear() {
      this.scheduleFilterRefresh();
    },
  },

  methods: {
    setStatus(text, type = 'info') {
      this.status = text;
      this.statusType = type;
    },

    syncFirebaseBadge(connected, message) {
      if (typeof window.setFirebaseNavStatus === 'function') {
        window.setFirebaseNavStatus(connected, message);
      }
    },

    initFirebase() {
      if (!window.firebaseConfig || !window.firebaseConfig.apiKey) {
        this.syncFirebaseBadge(false, 'เชื่อมต่อไม่ได้');
        this.setStatus('ยังไม่ตั้งค่า Firebase config', 'warn');
        return false;
      }

      try {
        if (!firebase.apps.length) firebase.initializeApp(window.firebaseConfig);
        if (!firebaseDb) firebaseDb = firebase.database();
        return true;
      } catch (err) {
        console.error(err);
        this.setStatus(`เริ่ม Firebase ไม่สำเร็จ: ${err.message || err}`, 'error');
        return false;
      }
    },

    detachFirebaseInfoListener() {
      if (firebaseInfoRef && firebaseInfoCallback) {
        try {
          firebaseInfoRef.off('value', firebaseInfoCallback);
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

      firebaseInfoRef = firebaseDb.ref('.info/connected');
      firebaseInfoCallback = (snapshot) => {
        const connected = !!snapshot.val();
        this.syncFirebaseBadge(connected, connected ? 'เชื่อมต่อ Firebase ได้ปกติ' : 'เชื่อมต่อไม่ได้');
      };

      firebaseInfoRef.on('value', firebaseInfoCallback, (err) => {
        console.error(err);
        this.syncFirebaseBadge(false, 'เชื่อมต่อไม่ได้');
        this.setStatus(`อ่านสถานะการเชื่อมต่อ Firebase ไม่สำเร็จ: ${err.message || err}`, 'error');
      });
    },

    getPlateText(vehicleId) {
      const map = this.mappingsByVehicle[vehicleId];
      return map && map.plate ? map.plate : 'ยังไม่จับคู่';
    },
    formatDateTime(value) {
      return formatDateTime(value);
    },

    // สร้างฟังก์ชันกรองครั้งเดียวต่อรอบ (ตรรกะเดิมของ matchesFilter)
    buildFilterMatcher() {
      if (this.filterMode === 'day') {
        const selected = toDateSafe(this.filterDate);
        return (date) => (date && selected ? sameCalendarDay(date, selected) : false);
      }

      if (this.filterMode === 'month') {
        const [year, month] = String(this.filterMonth || '').split('-').map(Number);
        return (date) =>
          !!date &&
          Number.isFinite(year) &&
          Number.isFinite(month) &&
          date.getFullYear() === year &&
          date.getMonth() + 1 === month;
      }

      if (this.filterMode === 'year') {
        const year = Number(this.filterYear);
        return (date) => !!date && Number.isFinite(year) && date.getFullYear() === year;
      }

      return (date) => !!date;
    },

    // prefix ของ key ที่ใช้ query ตามช่วงที่เลือก (null = ค่าตัวกรองไม่ถูกต้อง)
    periodPrefix() {
      if (this.filterMode === 'day') {
        const v = String(this.filterDate || '');
        return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
      }
      if (this.filterMode === 'month') {
        const v = String(this.filterMonth || '');
        return /^\d{4}-\d{2}$/.test(v) ? v : null;
      }
      if (this.filterMode === 'year') {
        const v = String(this.filterYear || '').trim();
        return /^\d{4}$/.test(v) ? v : null;
      }
      return null;
    },

    isTodaySelected() {
      return this.filterMode === 'day' && this.filterDate === todayISODate();
    },

    scheduleFilterRefresh() {
      // ทิ้งผลของ request ที่กำลังวิ่งอยู่ทันที แล้วรอ 400 ms ค่อยดึงใหม่
      requestSeq += 1;
      if (filterDebounceTimer) clearTimeout(filterDebounceTimer);
      filterDebounceTimer = setTimeout(() => {
        filterDebounceTimer = null;
        this.refreshAll();
      }, FILTER_DEBOUNCE_MS);
    },

    autoRefreshTick() {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (!this.isTodaySelected()) return;
      if (inFlight || this.loading) return;
      this.refreshAll({ incremental: true });
    },

    parsePoints(rowsInput) {
      const rows = (rowsInput || []).slice();
      rows.sort((a, b) => a.date.getTime() - b.date.getTime());

      const matches = this.buildFilterMatcher();
      const points = [];
      let lastAccepted = null;

      rows.forEach((row) => {
        if (!matches(row.date)) return;

        const suspicious = lastAccepted ? isSuspiciousJump(lastAccepted, row) : null;
        if (suspicious) return;

        points.push({
          ...row,
          pointNo: points.length + 1,
        });
        lastAccepted = points[points.length - 1];
      });

      return points;
    },

    buildSegments(points) {
      const pts = points || [];
      if (!pts.length) return [];

      const segments = [];
      let current = [pts[0]];
      const gapThresholdMs = 60 * 1000;

      for (let i = 1; i < pts.length; i += 1) {
        const prev = pts[i - 1];
        const curr = pts[i];
        const prevTime = prev.date ? prev.date.getTime() : null;
        const currTime = curr.date ? curr.date.getTime() : null;
        const isGap =
          prevTime !== null &&
          currTime !== null &&
          currTime - prevTime > gapThresholdMs;
        const isNewDay = !sameCalendarDay(prev.date, curr.date);

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

    // ดึงรายชื่อรถ + mapping (mapping อ่านทุกครั้งที่ refresh แบบเต็ม เพราะเล็ก; รายชื่อรถ cache 10 นาทีใน sessionStorage)
    async loadVehicleListing(force) {
      const mappingSnap = await firebaseDb.ref('vehicle_mappings').once('value');
      const mappings = FQ.parseMappingsSnapshot(mappingSnap);
      const listing = await FQ.listVehicleIds(firebaseDb, { mappings, force });
      lastVehicleListing = listing;
      return listing;
    },

    vehicleIdsFromListing(listing) {
      if (!listing) return [];
      // เดิมหน้า dashboard วนเฉพาะรถที่มี node ใน locations; ถ้าอ่าน shallow ไม่ได้ ใช้รายชื่อจาก mapping แทน
      return listing.shallowError ? listing.mappingIds : listing.locationIds;
    },

    // ดึงข้อมูลของช่วง prefix ให้ครบทุกคัน: ใช้ cache ถ้าช่วงปิดแล้ว / ดึงต่อจาก lastKey ถ้าช่วงยังเปิด
    async loadPeriod(prefix, vehicleIds, { force = false } = {}) {
      const closedAtStart = isClosedPeriodPrefix(prefix);
      let entry = periodCache.get(prefix);
      if (!entry || force) {
        entry = { prefix, complete: false, vehicles: new Map() };
      }

      await Promise.all(
        vehicleIds.map(async (vehicleId) => {
          const existing = entry.vehicles.get(vehicleId);

          if (existing && entry.complete) return; // ช่วงในอดีตที่ดึงครบแล้ว ไม่ต้องดึงซ้ำ

          if (existing && existing.lastKey) {
            const snap = await FQ.fetchAfter(firebaseDb, vehicleId, existing.lastKey, prefix);
            // กรองซ้ำด้วย key > lastKey ปัจจุบัน กันกรณีมี request ของช่วงเดียวกันซ้อนกันแล้วต่อจุดซ้ำ
            const fresh = rowsFromSnapshot(snap, existing.lastKey).filter((r) => r.key > existing.lastKey);
            if (fresh.length) {
              existing.rows = existing.rows.concat(fresh);
              existing.lastKey = fresh[fresh.length - 1].key;
            }
            return;
          }

          const snap = await FQ.fetchRange(firebaseDb, vehicleId, prefix, prefix);
          const rows = rowsFromSnapshot(snap);
          entry.vehicles.set(vehicleId, {
            rows,
            lastKey: rows.length ? rows[rows.length - 1].key : null,
          });
        }),
      );

      // ข้อมูลของช่วงที่ปิดไปแล้วตั้งแต่ก่อนดึง ถือว่าครบ ไม่ต้อง refresh อีก
      entry.complete = closedAtStart;
      rememberPeriod(prefix, entry);
      return entry;
    },

    applyPeriod(entry, vehicleIds) {
      const live = {};
      let totalPoints = 0;
      let totalDistanceKmAll = 0;

      vehicleIds.forEach((vehicleIdRaw) => {
        const vehicleId = String(vehicleIdRaw || '').trim();
        if (!vehicleId) return;
        const data = entry.vehicles.get(vehicleId);
        if (!data || !data.rows.length) return;

        const points = this.parsePoints(data.rows);
        if (!points.length) return;

        const segments = this.buildSegments(points);
        const distanceKm = this.distanceKmFromSegments(segments);

        totalPoints += points.length;
        totalDistanceKmAll += distanceKm;

        live[vehicleId] = {
          // markRaw: ไม่ให้ Vue ทำ deep reactive ทุกจุด
          points: markRaw(points),
          segmentCount: segments.filter((s) => s.length >= 2).length,
          distanceKm,
        };
      });

      this.liveByVehicle = live;
      this.totalPointCount = totalPoints;
      this.totalDistanceKmAll = totalDistanceKmAll;
      this.lastUpdatedAt = new Date().toISOString();
      return Object.keys(live).length;
    },

    // opts.force = ปุ่ม "รีเฟรช" ดึงช่วงนี้ใหม่ทั้งหมด
    // opts.incremental = auto refresh (ใช้รายชื่อรถเดิม ดึงเฉพาะจุดหลัง lastKey)
    async refreshAll(opts = {}) {
      const force = !!(opts && opts.force === true);
      const incremental = !!(opts && opts.incremental === true) && !!lastVehicleListing;

      if (!incremental) this.subscribeFirebaseConnectionState();
      if (!this.initFirebase()) return;

      if (filterDebounceTimer && !incremental) {
        clearTimeout(filterDebounceTimer);
        filterDebounceTimer = null;
      }

      requestSeq += 1;
      const seq = requestSeq;
      inFlight = true;
      this.loading = true;
      this.setStatus(`กำลังดึงข้อมูล dashboard (${this.selectedPeriodText})...`, 'info');

      try {
        const listing = incremental ? lastVehicleListing : await this.loadVehicleListing(force);
        if (seq !== requestSeq) return;

        if (!incremental) this.mappingsByVehicle = listing.mappings;

        const vehicleIds = this.vehicleIdsFromListing(listing);
        const prefix = this.periodPrefix();

        let deviceCount = 0;
        if (prefix && vehicleIds.length) {
          const entry = await this.loadPeriod(prefix, vehicleIds, { force });
          if (seq !== requestSeq) return; // ผู้ใช้เปลี่ยนตัวกรองระหว่างรอ: ทิ้งผลนี้
          deviceCount = this.applyPeriod(entry, vehicleIds);
        } else {
          this.liveByVehicle = {};
          this.totalPointCount = 0;
          this.totalDistanceKmAll = 0;
          this.lastUpdatedAt = new Date().toISOString();
        }

        if (listing.shallowError) {
          this.setStatus(
            `อ่านรายชื่อรถจาก Firebase ไม่สำเร็จ (ใช้รายชื่อจาก vehicle_mappings แทน): ${listing.shallowError.message || listing.shallowError}`,
            'error',
          );
        } else if (deviceCount) {
          this.setStatus(
            `อัปเดตแล้ว: พบรถ ${deviceCount} คัน | รวมระยะ ${this.totalDistanceText}`,
            'ok',
          );
        } else {
          this.setStatus('ยังไม่พบข้อมูลรถตามช่วงเวลาที่เลือก', 'warn');
        }
      } catch (err) {
        console.error(err);
        if (seq !== requestSeq) return;
        this.syncFirebaseBadge(false, 'เชื่อมต่อไม่ได้');
        this.setStatus(`โหลด dashboard ไม่สำเร็จ: ${err.message || err}`, 'error');
      } finally {
        if (seq === requestSeq) {
          this.loading = false;
          inFlight = false;
        }
      }
    },
  },

  async mounted() {
    this.subscribeFirebaseConnectionState();
    await this.refreshAll();
    this.refreshTimer = setInterval(() => {
      this.autoRefreshTick();
    }, AUTO_REFRESH_MS);

    visibilityHandler = () => {
      if (document.visibilityState !== 'visible') return;
      const last = toDateSafe(this.lastUpdatedAt);
      if (!last || Date.now() - last.getTime() >= AUTO_REFRESH_MS) this.autoRefreshTick();
    };
    document.addEventListener('visibilitychange', visibilityHandler);
  },

  beforeUnmount() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (filterDebounceTimer) clearTimeout(filterDebounceTimer);
    if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler);
    if (firebaseInfoRef && firebaseInfoCallback) {
      try {
        firebaseInfoRef.off('value', firebaseInfoCallback);
      } catch (err) {
        console.warn(err);
      }
    }
  },
}).mount('#app');
