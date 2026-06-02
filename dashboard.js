const { createApp } = Vue;

let firebaseDb = null;
let firebaseInfoRef = null;
let firebaseInfoCallback = null;

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

function polarToCartesian(cx, cy, radius, angleDeg) {
  const angleRad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(angleRad),
    y: cy + radius * Math.sin(angleRad),
  };
}

function describePieSlice(cx, cy, radius, startAngle, endAngle) {
  const start = polarToCartesian(cx, cy, radius, endAngle);
  const end = polarToCartesian(cx, cy, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? 0 : 1;
  return [
    `M ${cx} ${cy}`,
    `L ${start.x} ${start.y}`,
    `A ${radius} ${radius} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`,
    'Z',
  ].join(' ');
}

function pieLabelPoint(cx, cy, radius, angleDeg) {
  const point = polarToCartesian(cx, cy, radius, angleDeg);
  return { x: point.x, y: point.y };
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
      this.refreshAll();
    },
    filterDate() {
      this.refreshAll();
    },
    filterMonth() {
      this.refreshAll();
    },
    filterYear() {
      this.refreshAll();
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

    formatAxisDistance(value) {
      return formatDistanceAxis(value);
    },

    splitLabelLines(text, maxLineLength = 12) {
      return splitLabelLines(text, maxLineLength);
    },

    matchesFilter(date) {
      if (!date) return false;

      if (this.filterMode === 'day') {
        const selected = toDateSafe(this.filterDate);
        return selected ? sameCalendarDay(date, selected) : false;
      }

      if (this.filterMode === 'month') {
        const [year, month] = String(this.filterMonth || '').split('-').map(Number);
        return (
          Number.isFinite(year) &&
          Number.isFinite(month) &&
          date.getFullYear() === year &&
          date.getMonth() + 1 === month
        );
      }

      if (this.filterMode === 'year') {
        const year = Number(this.filterYear);
        return Number.isFinite(year) && date.getFullYear() === year;
      }

      return true;
    },

    parsePoints(snapshot) {
      const rows = [];

      snapshot.forEach((child) => {
        const value = child.val() || {};
        const lat = Number(value.lat);
        const lng = Number(value.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

        const timestampiso = String(value.timestampiso || child.key || '');
        const date = toDateSafe(timestampiso);
        if (!date) return;

        rows.push({
          key: child.key,
          lat,
          lng,
          timestampiso,
          date,
        });
      });

      rows.sort((a, b) => a.date.getTime() - b.date.getTime());

      const points = [];
      let lastAccepted = null;

      rows.forEach((row) => {
        if (!this.matchesFilter(row.date)) return;

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

    async refreshAll() {
      this.subscribeFirebaseConnectionState();
      if (!this.initFirebase()) return;

      this.loading = true;
      this.setStatus(`กำลังดึงข้อมูล dashboard (${this.selectedPeriodText})...`, 'info');

      try {
        const [mappingSnap, locationsSnap] = await Promise.all([
          firebaseDb.ref('vehicle_mappings').once('value'),
          firebaseDb.ref('locations').once('value'),
        ]);

        const mappings = {};
        mappingSnap.forEach((child) => {
          const value = child.val() || {};
          const vehicleId = String(child.key || value.vehicle_id || '').trim();
          if (!vehicleId) return;
          mappings[vehicleId] = {
            plate: String(value.plate || value.license_plate || '').trim(),
            note: String(value.note || '').trim(),
            updatedAt: value.updatedAt || value.updated_at || null,
          };
        });
        this.mappingsByVehicle = mappings;

        const live = {};
        let totalPoints = 0;
        let totalDistanceKmAll = 0;

        locationsSnap.forEach((vehicleNode) => {
          const vehicleId = String(vehicleNode.key || '').trim();
          if (!vehicleId) return;

          const points = this.parsePoints(vehicleNode);
          if (!points.length) return;

          const segments = this.buildSegments(points);
          const distanceKm = this.distanceKmFromSegments(segments);

          totalPoints += points.length;
          totalDistanceKmAll += distanceKm;

          live[vehicleId] = {
            points,
            segmentCount: segments.filter((s) => s.length >= 2).length,
            distanceKm,
          };
        });

        this.liveByVehicle = live;
        this.totalPointCount = totalPoints;
        this.totalDistanceKmAll = totalDistanceKmAll;
        this.lastUpdatedAt = new Date().toISOString();

        const deviceCount = Object.keys(live).length;
        if (deviceCount) {
          this.setStatus(
            `อัปเดตแล้ว: พบรถ ${deviceCount} คัน | รวมระยะ ${this.totalDistanceText}`,
            'ok',
          );
        } else {
          this.setStatus('ยังไม่พบข้อมูลรถตามช่วงเวลาที่เลือก', 'warn');
        }
      } catch (err) {
        console.error(err);
        this.syncFirebaseBadge(false, 'เชื่อมต่อไม่ได้');
        this.setStatus(`โหลด dashboard ไม่สำเร็จ: ${err.message || err}`, 'error');
      } finally {
        this.loading = false;
      }
    },
  },

  async mounted() {
    this.subscribeFirebaseConnectionState();
    await this.refreshAll();
    this.refreshTimer = setInterval(() => {
      this.refreshAll();
    }, 30000);
  },

  beforeUnmount() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (firebaseInfoRef && firebaseInfoCallback) {
      try {
        firebaseInfoRef.off('value', firebaseInfoCallback);
      } catch (err) {
        console.warn(err);
      }
    }
  },
}).mount('#app');
