/**
 * export.js - Timetable Export Engine
 * Supports:
 *  - F34: High-resolution PNG Image Export via standalone html2canvas (with title header & watermark)
 *  - F35: Formatted Excel (.xlsx) Workbook Export via standalone SheetJS (XLSX)
 *  - F35: RFC 5545 iCalendar (.ics) Export
 *  - F30: Registration Code Clipboard Copy
 */
(function (root) {
  'use strict';

  const PERIOD_FALLBACK = {
    1:  { start: 405, end: 450 },
    2:  { start: 455, end: 500 },
    3:  { start: 505, end: 550 },
    4:  { start: 560, end: 605 },
    5:  { start: 610, end: 655 },
    6:  { start: 660, end: 705 },
    7:  { start: 750, end: 795 },
    8:  { start: 800, end: 845 },
    9:  { start: 850, end: 895 },
    10: { start: 905, end: 950 },
    11: { start: 955, end: 1000 },
    12: { start: 1005, end: 1050 },
    13: { start: 1065, end: 1110 },
    14: { start: 1115, end: 1160 },
    15: { start: 1165, end: 1210 },
    16: { start: 1215, end: 1260 }
  };

  function getPeriodTimes() {
    if (typeof root !== 'undefined' && root.Parser && root.Parser.PERIOD_TIMES) {
      return root.Parser.PERIOD_TIMES;
    }
    return PERIOD_FALLBACK;
  }

  function minuteToStr(minute) {
    const h = Math.floor(minute / 60);
    const m = minute % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  function periodRangeToMinutes(startPeriod, periodCount) {
    const times = getPeriodTimes();
    const p = parseInt(startPeriod, 10) || 1;
    const cnt = Math.max(1, parseInt(periodCount, 10) || 1);
    const endP = p + cnt - 1;
    const startMin = times[p] ? times[p].start : 405 + (p - 1) * 50;
    const endMin = times[endP] ? times[endP].end : startMin + cnt * 50;
    return { startMinute: startMin, endMinute: endMin };
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function formatYMD(dateObj) {
    return (
      dateObj.getFullYear() +
      pad2(dateObj.getMonth() + 1) +
      pad2(dateObj.getDate())
    );
  }

  function triggerBlobDownload(blob, filename) {
    if (typeof document === 'undefined') return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function triggerDataUrlDownload(dataUrl, filename) {
    if (typeof document === 'undefined') return;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 1000);
  }

  function computeMetricsFallback(classes) {
    if (typeof root !== 'undefined' && root.Scheduler && typeof root.Scheduler.calculateMetrics === 'function') {
      return root.Scheduler.calculateMetrics(classes || []);
    }
    const occupiedMornings = new Set();
    const occupiedAfternoons = new Set();
    const occupiedDays = new Set();
    let morningHours = 0;
    let afternoonHours = 0;

    for (const sec of (classes || [])) {
      for (const s of (sec.sessions || [])) {
        const d = parseInt(s.day, 10);
        const startP = parseInt(s.startPeriod, 10) || 1;
        const pCount = parseInt(s.periodCount, 10) || 1;
        if (Number.isFinite(d)) occupiedDays.add(d);
        const mins = (s.endMinute !== undefined && s.startMinute !== undefined)
          ? (Number(s.endMinute) - Number(s.startMinute))
          : (pCount * 45);
        const hours = mins / 60;
        if (startP <= 6) {
          if (Number.isFinite(d)) occupiedMornings.add(d);
          morningHours += hours;
        } else if (startP <= 12) {
          if (Number.isFinite(d)) occupiedAfternoons.add(d);
          afternoonHours += hours;
        }
      }
    }

    const freeMornings = 7 - occupiedMornings.size;
    const freeAfternoons = 7 - occupiedAfternoons.size;
    return {
      freeMornings: freeMornings,
      freeAfternoons: freeAfternoons,
      freeHalfDays: freeMornings + freeAfternoons,
      freeFullDays: 7 - occupiedDays.size,
      morningHours: Math.round(morningHours * 100) / 100,
      afternoonHours: Math.round(afternoonHours * 100) / 100
    };
  }

  /**
   * Build a formatted SheetJS workbook for a ScheduleOption.
   * Handles alternating-week overlapping sessions cleanly without overlapping SheetJS merges.
   */
  function buildExcelWorkbook(scheduleOption, title) {
    const XLSXLib = root.XLSX || (typeof XLSX !== 'undefined' ? XLSX : null);
    if (!XLSXLib) {
      throw new Error('Thư viện SheetJS (XLSX) chưa được tải.');
    }

    const opt = scheduleOption || { id: 1, classes: [] };
    const classes = Array.isArray(opt.classes) ? opt.classes : [];
    const metrics = opt.metrics || computeMetricsFallback(classes);
    const sheetTitle = title || 'Thời khóa biểu cá nhân';

    let maxPeriod = 12;
    for (const sec of classes) {
      for (const s of (sec.sessions || [])) {
        const startP = Math.max(1, parseInt(s.startPeriod, 10) || 1);
        const pCount = Math.max(1, parseInt(s.periodCount, 10) || 1);
        const endP = startP + pCount - 1;
        if (endP > maxPeriod) maxPeriod = Math.min(16, endP);
      }
    }

    const totalRows = maxPeriod + 4; // rows 1..totalRows (1-based)
    const aoa = Array.from({ length: totalRows }, () => Array(8).fill(''));

    // Row 1 (index 0): Title
    aoa[0][0] = sheetTitle;

    // Row 2 (index 1): Summary metrics
    aoa[1][0] =
      `Tổng số môn: ${classes.length} | ` +
      `Buổi sáng nghỉ: ${metrics.freeMornings} | ` +
      `Buổi chiều nghỉ: ${metrics.freeAfternoons} | ` +
      `Ngày nghỉ trọn vẹn: ${metrics.freeFullDays}`;

    // Row 4 (index 3): Headers
    const headers = ['Tiết', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7', 'Chủ Nhật'];
    for (let c = 0; c < 8; c++) {
      aoa[3][c] = headers[c];
    }

    // Rows 5..totalRows (Periods 1..maxPeriod)
    const times = getPeriodTimes();
    for (let p = 1; p <= maxPeriod; p++) {
      const rIdx = p + 3; // 0-based row index (p=1 -> index 4 -> Excel Row 5)
      const pt = times[p] || { start: 405 + (p - 1) * 50, end: 450 + (p - 1) * 50 };
      aoa[rIdx][0] = `Tiết ${p}\n(${minuteToStr(pt.start)} - ${minuteToStr(pt.end)})`;
    }

    // Group sessions by day (2..8) to detect period overlaps cleanly
    const sessionsByDay = new Map();
    for (let d = 2; d <= 8; d++) sessionsByDay.set(d, []);

    for (const sec of classes) {
      for (const s of (sec.sessions || [])) {
        const d = parseInt(s.day, 10);
        if (!Number.isFinite(d) || d < 2 || d > 8) continue;
        const startP = Math.max(1, parseInt(s.startPeriod, 10) || 1);
        if (startP > maxPeriod) continue;
        const pCount = Math.max(1, parseInt(s.periodCount, 10) || 1);
        const endP = Math.min(maxPeriod, startP + pCount - 1);
        const content = `${sec.courseName || ''}\n[${sec.id || ''}]\nPhòng: ${s.room || 'N/A'}`;
        sessionsByDay.get(d).push({
          sec,
          session: s,
          startP,
          endP,
          content
        });
      }
    }

    const merges = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 7 } }, // A1:H1
      { s: { r: 1, c: 0 }, e: { r: 1, c: 7 } }  // A2:H2
    ];

    // Fill cells & safe merges per day
    for (let d = 2; d <= 8; d++) {
      const colIdx = d - 1; // day 2 -> col B (index 1), ..., day 8 -> col H (index 7)
      const list = sessionsByDay.get(d);
      if (!list || list.length === 0) continue;

      // Track which periods belong to which entries
      const periodEntries = new Map();
      for (const item of list) {
        for (let p = item.startP; p <= item.endP; p++) {
          if (!periodEntries.has(p)) periodEntries.set(p, []);
          periodEntries.get(p).push(item);
        }
      }

      // Determine which items have any overlap with another item
      const hasOverlap = new Set();
      for (const [, items] of periodEntries.entries()) {
        if (items.length > 1) {
          for (const it of items) hasOverlap.add(it);
        }
      }

      // Non-overlapping items can safely merge vertically across their period range
      for (const item of list) {
        if (!hasOverlap.has(item)) {
          const startRowIdx = item.startP + 3;
          const endRowIdx = item.endP + 3;
          aoa[startRowIdx][colIdx] = item.content;
          if (endRowIdx > startRowIdx) {
            merges.push({
              s: { r: startRowIdx, c: colIdx },
              e: { r: endRowIdx, c: colIdx }
            });
          }
        }
      }

      // Overlapping items write combined content per period (avoiding conflicting merges)
      for (const [p, items] of periodEntries.entries()) {
        if (items.length > 1 || hasOverlap.has(items[0])) {
          const rowIdx = p + 3;
          aoa[rowIdx][colIdx] = items.map(it => it.content).join('\n---\n');
        }
      }
    }

    const ws = XLSXLib.utils.aoa_to_sheet(aoa);
    ws['!merges'] = merges;
    ws['!cols'] = [
      { wch: 18 },
      { wch: 22 },
      { wch: 22 },
      { wch: 22 },
      { wch: 22 },
      { wch: 22 },
      { wch: 22 },
      { wch: 22 }
    ];
    ws['!rows'] = [
      { hpt: 28 },
      { hpt: 20 },
      { hpt: 12 },
      { hpt: 24 }
    ];

    const wb = XLSXLib.utils.book_new();
    XLSXLib.utils.book_append_sheet(wb, ws, 'Thời khóa biểu');
    return wb;
  }

  /**
   * Generate .xlsx file bytes (Uint8Array) for verification or custom saving.
   */
  function exportExcelBytes(scheduleOption, title) {
    const XLSXLib = root.XLSX || (typeof XLSX !== 'undefined' ? XLSX : null);
    const wb = buildExcelWorkbook(scheduleOption, title);
    const out = XLSXLib.write(wb, { bookType: 'xlsx', type: 'array' });
    if (out instanceof Uint8Array) return out;
    if (out instanceof ArrayBuffer) return new Uint8Array(out);
    if (ArrayBuffer.isView(out)) return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    return new Uint8Array(out);
  }

  /**
   * Trigger Excel (.xlsx) download for the active ScheduleOption.
   */
  function exportExcel(scheduleOption, title) {
    const XLSXLib = root.XLSX || (typeof XLSX !== 'undefined' ? XLSX : null);
    const wb = buildExcelWorkbook(scheduleOption, title);
    const optId = (scheduleOption && scheduleOption.id) ? scheduleOption.id : 1;
    const filename = `TKB_Option_${optId}.xlsx`;
    if (typeof document !== 'undefined') {
      XLSXLib.writeFile(wb, filename);
    }
    return { workbook: wb, filename };
  }

  /**
   * Escape text values per RFC 5545 Section 3.3.11.
   */
  function escapeICalText(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r\n/g, '\\n')
      .replace(/[\r\n]/g, '\\n');
  }

  /**
   * Generate RFC 5545 iCalendar (.ics) string with CRLF line endings.
   */
  function generateICalString(scheduleOption, semesterStartDate) {
    const opt = scheduleOption || { id: 1, classes: [] };
    const classes = Array.isArray(opt.classes) ? opt.classes : [];

    let baseDate;
    if (semesterStartDate instanceof Date && !Number.isNaN(semesterStartDate.getTime())) {
      baseDate = new Date(semesterStartDate.getFullYear(), semesterStartDate.getMonth(), semesterStartDate.getDate());
    } else if (typeof semesterStartDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(semesterStartDate)) {
      const parts = semesterStartDate.split('-').map(Number);
      baseDate = new Date(parts[0], parts[1] - 1, parts[2]);
    } else {
      // Default Monday: 2027-02-01
      baseDate = new Date(2027, 1, 1);
    }

    const now = new Date();
    const dtstamp =
      now.getUTCFullYear() +
      pad2(now.getUTCMonth() + 1) +
      pad2(now.getUTCDate()) + 'T' +
      pad2(now.getUTCHours()) +
      pad2(now.getUTCMinutes()) +
      pad2(now.getUTCSeconds()) + 'Z';

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//HUST_UED_Timetable//VN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH'
    ];

    let eventIdx = 0;
    for (const sec of classes) {
      for (const s of (sec.sessions || [])) {
        const day = parseInt(s.day, 10) || 2;
        const dayOffset = day - 2;
        const startP = parseInt(s.startPeriod, 10) || 1;
        const pCount = parseInt(s.periodCount, 10) || 1;

        const rawWeeks = Array.isArray(s.weeks)
          ? Array.from(new Set(s.weeks.map(w => parseInt(w, 10)).filter(w => Number.isFinite(w) && w >= 1))).sort((a, b) => a - b)
          : [];
        const firstWeek = rawWeeks.length > 0 ? rawWeeks[0] : 1;
        const firstDate = new Date(
          baseDate.getFullYear(),
          baseDate.getMonth(),
          baseDate.getDate() + (firstWeek - 1) * 7 + dayOffset
        );

        let startMin = s.startMinute;
        let endMin = s.endMinute;
        if (startMin === undefined || endMin === undefined || startMin === null || endMin === null) {
          const calc = periodRangeToMinutes(startP, pCount);
          if (startMin === undefined || startMin === null) startMin = calc.startMinute;
          if (endMin === undefined || endMin === null) endMin = calc.endMinute;
        }
        startMin = Math.max(0, Math.min(1439, Math.floor(Number(startMin) || 0)));
        endMin = Math.max(startMin, Math.min(1439, Math.floor(Number(endMin) || startMin)));

        const startH = Math.floor(startMin / 60);
        const startM = startMin % 60;
        const endH = Math.floor(endMin / 60);
        const endM = endMin % 60;

        const ymd = formatYMD(firstDate);
        const timeStartSuffix = `T${pad2(startH)}${pad2(startM)}00`;
        const dtstart = `${ymd}${timeStartSuffix}`;
        const dtend = `${ymd}T${pad2(endH)}${pad2(endM)}00`;
        const uidCourse = String(sec.courseId || 'CRS').replace(/[\r\n\s]/g, '');
        const uidSec = String(sec.id || 'SEC').replace(/[\r\n\s]/g, '');
        const uid = `${uidCourse}_${uidSec}_${day}_${startP}_${eventIdx || 0}_${ymd}@tkb`;
        eventIdx++;

        const summaryText = escapeICalText(`${sec.courseName || ''} (${sec.id || ''})`);
        const descText = escapeICalText(
          `Lớp: ${sec.cohort || ''}\nGiảng viên: ${sec.lecturer || 'Chưa phân công'}\nLoại: ${sec.type || ''}`
        );
        const locationText = escapeICalText(s.room || 'TBD');

        let recurrenceLine = 'RRULE:FREQ=WEEKLY;COUNT=16';
        if (rawWeeks.length === 1) {
          recurrenceLine = 'RRULE:FREQ=WEEKLY;COUNT=1';
        } else if (rawWeeks.length >= 2) {
          const step = rawWeeks[1] - rawWeeks[0];
          let uniform = step >= 1;
          for (let wi = 2; wi < rawWeeks.length; wi++) {
            if (rawWeeks[wi] - rawWeeks[wi - 1] !== step) {
              uniform = false;
              break;
            }
          }
          if (uniform) {
            recurrenceLine = step === 1
              ? `RRULE:FREQ=WEEKLY;COUNT=${rawWeeks.length}`
              : `RRULE:FREQ=WEEKLY;INTERVAL=${step};COUNT=${rawWeeks.length}`;
          } else {
            const rdates = rawWeeks.slice(1).map(w => {
              const dObj = new Date(
                baseDate.getFullYear(),
                baseDate.getMonth(),
                baseDate.getDate() + (w - 1) * 7 + dayOffset
              );
              return `${formatYMD(dObj)}${timeStartSuffix}`;
            });
            recurrenceLine = `RDATE:${rdates.join(',')}`;
          }
        }

        lines.push('BEGIN:VEVENT');
        lines.push(`UID:${uid}`);
        lines.push(`DTSTAMP:${dtstamp}`);
        lines.push(`DTSTART:${dtstart}`);
        lines.push(`DTEND:${dtend}`);
        lines.push(`SUMMARY:${summaryText}`);
        lines.push(`DESCRIPTION:${descText}`);
        lines.push(`LOCATION:${locationText}`);
        lines.push(recurrenceLine);
        lines.push('STATUS:CONFIRMED');
        lines.push('END:VEVENT');
      }
    }

    lines.push('END:VCALENDAR');
    return lines.join('\r\n') + '\r\n';
  }

  /**
   * Export iCalendar (.ics) file and trigger browser download.
   */
  function exportICal(scheduleOption, semesterStartDate) {
    const icsContent = generateICalString(scheduleOption, semesterStartDate);
    const optId = (scheduleOption && scheduleOption.id) ? scheduleOption.id : 1;
    const filename = `TKB_Option_${optId}.ics`;
    if (typeof Blob !== 'undefined' && typeof document !== 'undefined') {
      const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
      triggerBlobDownload(blob, filename);
    }
    return icsContent;
  }

  /**
   * Export weekly timetable grid element as high-resolution PNG via html2canvas.
   * Includes styled header title and watermark footer.
   */
  async function exportImage(gridElement, title, options) {
    const h2c = root.html2canvas || (typeof html2canvas !== 'undefined' ? html2canvas : null);
    if (!h2c) {
      throw new Error('Thư viện html2canvas chưa được tải.');
    }
    if (!gridElement) {
      throw new Error('Không tìm thấy bảng thời khóa biểu để xuất ảnh.');
    }

    const opts = options || {};
    const optionId = opts.optionId || 1;
    const headerTitle = title || 'Thời khóa biểu HK Xuân 2026-2027';
    const watermarkText = opts.watermark || 'Generated via TKB HUST/UED Scheduler';
    const filename = opts.filename || `TKB_HK_Xuan_Option_${optionId}.png`;
    const scale = opts.scale || 2;

    const wrapper = document.createElement('div');
    wrapper.className = 'export-snapshot-wrapper';
    wrapper.style.position = 'fixed';
    wrapper.style.left = '-10000px';
    wrapper.style.top = '0';
    wrapper.style.width = Math.max(gridElement.scrollWidth || 1000, 1000) + 'px';
    wrapper.style.padding = '24px 28px';
    wrapper.style.backgroundColor = '#ffffff';
    wrapper.style.fontFamily = "'Segoe UI', Roboto, Arial, sans-serif";
    wrapper.style.color = '#1e293b';
    wrapper.style.boxSizing = 'border-box';
    wrapper.style.zIndex = '-1';

    const headerEl = document.createElement('div');
    headerEl.style.display = 'flex';
    headerEl.style.justifyContent = 'space-between';
    headerEl.style.alignItems = 'center';
    headerEl.style.marginBottom = '14px';
    headerEl.style.paddingBottom = '10px';
    headerEl.style.borderBottom = '2px solid #e2e8f0';

    const titleEl = document.createElement('h2');
    titleEl.textContent = headerTitle;
    titleEl.style.margin = '0';
    titleEl.style.fontSize = '20px';
    titleEl.style.fontWeight = '700';
    titleEl.style.color = '#1d4ed8';

    const subEl = document.createElement('span');
    subEl.textContent = opts.subtitle || `Phương án #${optionId}`;
    subEl.style.fontSize = '13px';
    subEl.style.color = '#475569';
    subEl.style.fontWeight = '600';

    headerEl.appendChild(titleEl);
    headerEl.appendChild(subEl);

    const clonedGrid = gridElement.cloneNode(true);
    clonedGrid.style.transform = 'none';
    clonedGrid.style.width = '100%';
    clonedGrid.style.maxHeight = 'none';
    clonedGrid.style.overflow = 'visible';

    const footerEl = document.createElement('div');
    footerEl.textContent = watermarkText;
    footerEl.style.marginTop = '12px';
    footerEl.style.paddingTop = '8px';
    footerEl.style.borderTop = '1px solid #e2e8f0';
    footerEl.style.textAlign = 'right';
    footerEl.style.fontSize = '11px';
    footerEl.style.color = '#64748b';
    footerEl.style.fontStyle = 'italic';

    wrapper.appendChild(headerEl);
    wrapper.appendChild(clonedGrid);
    wrapper.appendChild(footerEl);
    document.body.appendChild(wrapper);

    try {
      const canvas = await h2c(wrapper, {
        scale: scale,
        backgroundColor: '#ffffff',
        useCORS: true,
        logging: false
      });
      const dataUrl = canvas.toDataURL('image/png');
      if (!opts.skipDownload) {
        triggerDataUrlDownload(dataUrl, filename);
      }
      return {
        dataUrl,
        width: canvas.width,
        height: canvas.height,
        filename,
        watermark: watermarkText
      };
    } finally {
      if (wrapper.parentNode) {
        wrapper.parentNode.removeChild(wrapper);
      }
    }
  }

  /**
   * Copy registration codes for the active ScheduleOption to clipboard.
   */
  async function copyRegistrationCodes(scheduleOption, separator) {
    const sep = separator !== undefined ? separator : ', ';
    const classes = (scheduleOption && Array.isArray(scheduleOption.classes))
      ? scheduleOption.classes
      : [];
    const ids = classes.map(c => c.id).filter(Boolean);
    const text = ids.join(sep);

    if (!text) return '';

    let copied = false;
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        copied = await Promise.race([
          navigator.clipboard.writeText(text).then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 250))
        ]);
      } catch (err) {
        copied = false;
      }
    }

    if (!copied && typeof document !== 'undefined') {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (err) {
        // Ignore clipboard unavailability in headless environments
      }
    }

    return text;
  }

  const Exporter = {
    buildExcelWorkbook: buildExcelWorkbook,
    exportExcelBytes: exportExcelBytes,
    exportExcel: exportExcel,
    generateICalString: generateICalString,
    exportICal: exportICal,
    exportImage: exportImage,
    copyRegistrationCodes: copyRegistrationCodes
  };

  if (typeof window !== 'undefined') {
    window.Exporter = Exporter;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Exporter;
  }
  if (typeof root !== 'undefined' && !root.Exporter) {
    root.Exporter = Exporter;
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
