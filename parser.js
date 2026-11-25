/**
 * parser.js - Dynamic Timetable Parser & Schema Normalizer
 * Provides full feature parity with TKB HUST / UED timetable specifications.
 * Supports dynamic header detection (UED 13-column, HUST 25-column),
 * multi-session class grouping, period-to-minute geometry, and Vietnamese error handling.
 */
(function(root) {
  'use strict';

  // Bell schedule: Vietnamese University Timetable (UED & HUST)
  // Morning: Periods 1 to 6 (06:45 - 11:45)
  // Afternoon: Periods 7 to 12 (12:30 - 17:30)
  // Evening: Periods 13 to 16 (17:45 - 20:55)
  const PERIOD_TIMES = {
    1:  { start: 405, end: 450 },  // 06:45 - 07:30
    2:  { start: 455, end: 500 },  // 07:35 - 08:20
    3:  { start: 505, end: 550 },  // 08:25 - 09:10
    4:  { start: 560, end: 605 },  // 09:20 - 10:05
    5:  { start: 610, end: 655 },  // 10:10 - 10:55
    6:  { start: 660, end: 705 },  // 11:00 - 11:45
    // Nghỉ trưa: 11:45 - 12:30 (45 phút)
    7:  { start: 750, end: 795 },  // 12:30 - 13:15
    8:  { start: 800, end: 845 },  // 13:20 - 14:05
    9:  { start: 850, end: 895 },  // 14:10 - 14:55
    10: { start: 905, end: 950 },  // 15:05 - 15:50
    11: { start: 955, end: 1000 }, // 15:55 - 16:40
    12: { start: 1005, end: 1050 },// 16:45 - 17:30
    // Ca tối (nếu có)
    13: { start: 1065, end: 1110 },// 17:45 - 18:30
    14: { start: 1115, end: 1160 },// 18:35 - 19:20
    15: { start: 1165, end: 1210 },// 19:25 - 20:10
    16: { start: 1215, end: 1260 } // 20:15 - 21:00
  };

  const Parser = {
    PERIOD_TIMES: PERIOD_TIMES,

    /**
     * Convert startPeriod and periodCount into (startMinute, endMinute)
     */
    periodToMinutes(startPeriod, periodCount) {
      const p = parseInt(startPeriod, 10);
      const cnt = Math.max(1, parseInt(periodCount, 10) || 1);
      const endP = p + cnt - 1;

      const startMin = PERIOD_TIMES[p] ? PERIOD_TIMES[p].start : 405 + (p - 1) * 50;
      const endMin = PERIOD_TIMES[endP] ? PERIOD_TIMES[endP].end : startMin + cnt * 50;
      return { startMinute: startMin, endMinute: endMin };
    },

    /**
     * Map startPeriod to session type ('Sáng', 'Chiều', 'Tối')
     */
    periodToSessionType(startPeriod) {
      const p = parseInt(startPeriod, 10);
      if (p >= 1 && p <= 6) return 'Sáng';
      if (p >= 7 && p <= 12) return 'Chiều';
      return 'Tối';
    },

    /**
     * Parse week representations like '1-8, 10-16', '1-15 (lẻ)', or binary '1111111100000000'
     */
    parseWeeks(val) {
      if (val === null || val === undefined || val === '') {
        return Array.from({ length: 20 }, (_, i) => i + 1);
      }
      if (typeof val === 'number') {
        return [val];
      }
      const s = String(val).trim();
      if (!s) {
        return Array.from({ length: 20 }, (_, i) => i + 1);
      }

      // Binary string e.g. '111111110000' (require length >= 4 so '10', '11' parse as decimal weeks)
      if (/^[01]{4,}$/.test(s)) {
        const weeks = [];
        for (let i = 0; i < s.length; i++) {
          if (s[i] === '1') weeks.push(i + 1);
        }
        return weeks.length > 0 ? weeks : Array.from({ length: 20 }, (_, i) => i + 1);
      }

      const isOdd = /lẻ/i.test(s);
      const isEven = /chẵn/i.test(s);

      // Remove parenthesized comments e.g. (lẻ), (chẵn)
      const cleaned = s.replace(/\(.*?\)/g, '').trim();
      const tokens = cleaned.split(/[,;|]/);
      const weekSet = new Set();

      for (let rawToken of tokens) {
        const token = rawToken.trim();
        if (!token) continue;

        // Range match e.g. 1-8 or 10 - 16
        const rangeMatch = token.match(/^(\d+)\s*[-–—.]+\s*(\d+)$/);
        if (rangeMatch) {
          const start = parseInt(rangeMatch[1], 10);
          const end = parseInt(rangeMatch[2], 10);
          const minW = Math.min(start, end);
          const maxW = Math.max(start, end);
          for (let w = minW; w <= maxW; w++) {
            if (isOdd && w % 2 === 0) continue;
            if (isEven && w % 2 !== 0) continue;
            weekSet.add(w);
          }
        } else {
          // Individual numbers or whitespace separated
          const parts = token.split(/\s+/);
          for (let part of parts) {
            if (/^\d+$/.test(part)) {
              const w = parseInt(part, 10);
              if (isOdd && w % 2 === 0) continue;
              if (isEven && w % 2 !== 0) continue;
              weekSet.add(w);
            }
          }
        }
      }

      const result = Array.from(weekSet).sort((a, b) => a - b);
      return result.length > 0 ? result : Array.from({ length: 20 }, (_, i) => i + 1);
    },

    /**
     * Parse credits from number or string formula like '3', '3.0', '3(3-1-0-6)'
     */
    parseCredits(val) {
      if (val === null || val === undefined) return 0;
      if (typeof val === 'number') return val;
      const s = String(val).trim();
      const m = s.match(/^(\d+(\.\d+)?)/);
      return m ? parseFloat(m[1]) : 0;
    },

    /**
     * Parse day string/number (2=Thứ 2, ..., 7=Thứ 7, 8=Chủ Nhật)
     */
    parseDay(val) {
      if (val === null || val === undefined) return 2;
      const s = String(val).trim().toUpperCase();
      if (s === 'CN' || s === 'CHỦ NHẬT' || s === 'CHU NHAT' || s === '8' || s === 'SUNDAY') {
        return 8;
      }
      const m = s.match(/\d+/);
      const d = m ? parseInt(m[0], 10) : 2;
      return (d >= 2 && d <= 8) ? d : 2;
    },

    /**
     * Dynamic header detection across the first 25 rows with disambiguation guards.
     */
    detectHeaderAndColMap(rows) {
      let headerRowIndex = -1;
      let colMap = null;
      let detectedFormat = 'UED';

      const scanLimit = Math.min(25, rows.length);
      for (let r = 0; r < scanLimit; r++) {
        const row = rows[r];
        if (!Array.isArray(row)) continue;

        const potentialMap = {};
        for (let c = 0; c < row.length; c++) {
          if (row[c] === null || row[c] === undefined) continue;
          const rawCell = String(row[c]).trim().toLowerCase();
          const cleanCell = rawCell.replace(/[\s_]+/g, '');

          // Disambiguation Guard 1: Course Code (Mã HP vs Mã lớp kèm)
          if (!('courseId' in potentialMap) &&
              (cleanCell.includes('mãhp') || cleanCell.includes('mahp') || cleanCell.includes('mãhọcphần') || cleanCell.includes('mahocphan')) &&
              !cleanCell.includes('kèm') && !cleanCell.includes('kem')) {
            potentialMap.courseId = c;
          }
          // Disambiguation Guard 2: Course Name (Tên HP vs Tên HP Tiếng Anh)
          else if (!('courseName' in potentialMap) &&
                   (cleanCell.includes('tênhp') || cleanCell.includes('tenhp') || cleanCell.includes('tênhọcphần') || cleanCell.includes('tenhocphan')) &&
                   !cleanCell.includes('tiếnganh') && !cleanCell.includes('tienganh') &&
                   !/(?:^|[\s_(\-/])en(?:$|[\s_)\-/])|english/.test(rawCell)) {
            potentialMap.courseName = c;
          }
          // Disambiguation Guard 3: Section ID (Nhóm vs Mã lớp vs Mã lớp kèm)
          else if (!('sectionId' in potentialMap) &&
                   (cleanCell === 'nhóm' || cleanCell === 'nhom' || cleanCell === 'mãlớp' || cleanCell === 'malop' || cleanCell.includes('mãlớp') || cleanCell.includes('malop')) &&
                   !cleanCell.includes('kèm') && !cleanCell.includes('kem')) {
            potentialMap.sectionId = c;
          }
          // Credits (TC, Số TC, Tín chỉ, Khối lượng)
          else if (!('credits' in potentialMap) &&
                   (cleanCell === 'tc' || cleanCell.includes('sốtc') || cleanCell.includes('sotc') || cleanCell.includes('khốilượng') || cleanCell.includes('khoiluong') || cleanCell.includes('tínchỉ') || cleanCell.includes('tinchi'))) {
            potentialMap.credits = c;
          }
          // Lecturer (Tên CB, Giảng viên, CBGD)
          else if (!('lecturer' in potentialMap) &&
                   (cleanCell.includes('têncb') || cleanCell.includes('tencb') || cleanCell.includes('giảngviên') || cleanCell.includes('giangvien') || cleanCell.includes('cbgd') || cleanCell.includes('cánbộ') || cleanCell.includes('canbo'))) {
            potentialMap.lecturer = c;
          }
          // Cohort / Student class (Lớp, Ghi chú)
          else if (!('cohort' in potentialMap) &&
                   (cleanCell === 'lớp' || cleanCell === 'lop' || cleanCell.includes('ghichú') || cleanCell.includes('ghichu'))) {
            potentialMap.cohort = c;
          }
          // Group code / Combined class (Mã ghép, Mã lớp kèm)
          else if (!('groupCode' in potentialMap) &&
                   (cleanCell.includes('mãghép') || cleanCell.includes('maghep') || cleanCell.includes('mãlớpkèm') || cleanCell.includes('malopkem') || cleanCell.includes('lớpkèm') || cleanCell.includes('lopkem'))) {
            potentialMap.groupCode = c;
          }
          // Room (Phòng)
          else if (!('room' in potentialMap) &&
                   (cleanCell.includes('phòng') || cleanCell.includes('phong'))) {
            potentialMap.room = c;
          }
          // Day of week (Thứ, Day)
          else if (!('day' in potentialMap) &&
                   (cleanCell === 'thứ' || cleanCell === 'thu' || cleanCell === 'day')) {
            potentialMap.day = c;
          }
          // Session type / Shift (Buổi, Kíp)
          else if (!('sessionType' in potentialMap) &&
                   (cleanCell === 'buổi' || cleanCell === 'buoi' || cleanCell === 'kíp' || cleanCell === 'kip')) {
            potentialMap.sessionType = c;
          }
          // Start Period (Tiết bắt đầu, BĐ)
          else if (!('startPeriod' in potentialMap) &&
                   (cleanCell.includes('tiếtbắtđầu') || cleanCell.includes('tietbatdau') || cleanCell === 'bđ' || cleanCell === 'bd' || cleanCell.includes('tiếtbđ') || cleanCell.includes('tietbd'))) {
            potentialMap.startPeriod = c;
          }
          // Period Count (Số tiết)
          else if (!('periodCount' in potentialMap) &&
                   (cleanCell.includes('sốtiết') || cleanCell.includes('sotiet'))) {
            potentialMap.periodCount = c;
          }
          // End Period (KT, Tiết kết thúc)
          else if (!('endPeriod' in potentialMap) &&
                   (cleanCell === 'kt' || cleanCell.includes('kếtthúc') || cleanCell.includes('ketthuc'))) {
            potentialMap.endPeriod = c;
          }
          // Combined Period String (Thời gian, Tiết: e.g. "7-9")
          else if (!('period' in potentialMap) &&
                   (cleanCell.includes('thờigian') || cleanCell.includes('thoigian') || cleanCell === 'tiết' || cleanCell === 'tiet')) {
            potentialMap.period = c;
          }
          // Study Weeks (Tuần)
          else if (!('weeks' in potentialMap) &&
                   (cleanCell.includes('tuần') || cleanCell.includes('tuan'))) {
            potentialMap.weeks = c;
          }
          // Class Type (Loại lớp)
          else if (!('classType' in potentialMap) &&
                   (cleanCell.includes('loạilớp') || cleanCell.includes('loailop'))) {
            potentialMap.classType = c;
          }
          // Faculty / School (Khoa, Viện, Trường)
          else if (!('faculty' in potentialMap) &&
                   (cleanCell.includes('trường') || cleanCell.includes('truong') || cleanCell.includes('khoa') || cleanCell.includes('viện') || cleanCell.includes('vien'))) {
            potentialMap.faculty = c;
          }
        }

        // Check if signature combination is present
        const hasCoreIds = potentialMap.courseId !== undefined && potentialMap.courseName !== undefined;
        const hasSchedule = potentialMap.day !== undefined &&
                            (potentialMap.startPeriod !== undefined || potentialMap.period !== undefined || potentialMap.periodCount !== undefined);

        if (hasCoreIds && (hasSchedule || potentialMap.sectionId !== undefined)) {
          headerRowIndex = r;
          colMap = potentialMap;

          // Determine format type
          const rowText = row.map(cell => String(cell || '').toLowerCase()).join(' ');
          if (rowText.includes('nhóm') || row.length <= 15) {
            detectedFormat = 'UED';
          } else if (rowText.includes('mã lớp') || rowText.includes('loại lớp') || row.length > 15) {
            detectedFormat = 'HUST';
          }
          break;
        }
      }

      return { headerRowIndex, colMap, format: detectedFormat };
    },

    /**
     * Parses an active SheetJS workbook object into standard { metadata, courses }
     */
    parse(workbook) {
      if (!workbook || !workbook.SheetNames || workbook.SheetNames.length === 0) {
        throw new Error("Tệp Excel rỗng: Không tìm thấy trang tính nào trong tệp.");
      }

      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      if (!worksheet) {
        throw new Error("Không thể đọc nội dung trang tính đầu tiên.");
      }

      // Convert sheet to array of rows
      if (typeof XLSX === 'undefined') {
        throw new Error("Thư viện SheetJS chưa được nạp. Vui lòng kiểm tra lib/xlsx.full.min.js.");
      }
      const rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

      if (!rawRows || rawRows.length === 0) {
        throw new Error("Bảng tính không chứa dữ liệu.");
      }

      // Extract metadata from top banner rows
      let semesterMeta = "HỌC KỲ XUÂN, NĂM HỌC 2026-2027";
      let schoolMeta = "TRƯỜNG ĐẠI HỌC SƯ PHẠM - ĐẠI HỌC ĐÀ NẴNG";
      for (let i = 0; i < Math.min(7, rawRows.length); i++) {
        const rowText = (rawRows[i] || []).map(cell => String(cell || '').trim()).filter(Boolean).join(' ');
        if (/HỌC\s*KỲ|THỜI\s*KHÓA\s*BIỂU/i.test(rowText)) {
          semesterMeta = rowText;
        }
        if (/TRƯỜNG\s*ĐẠI\s*HỌC\s*SƯ\s*PHẠM|ĐẠI\s*HỌC\s*ĐÀ\s*NẴNG/i.test(rowText)) {
          schoolMeta = "TRƯỜNG ĐẠI HỌC SƯ PHẠM - ĐẠI HỌC ĐÀ NẴNG";
        } else if (/ĐẠI\s*HỌC\s*BÁCH\s*KHOA/i.test(rowText)) {
          schoolMeta = "ĐẠI HỌC BÁCH KHOA HÀ NỘI";
        }
      }

      const { headerRowIndex, colMap, format } = this.detectHeaderAndColMap(rawRows);
      if (headerRowIndex === -1 || !colMap) {
        throw new Error("Không nhận diện được cấu trúc Thời khóa biểu. Tệp cần chứa các cột: Mã HP, Tên HP, Thứ, Nhóm/Mã lớp.");
      }

      const courses = {};
      const classSections = {};
      let rowCount = 0;

      for (let r = headerRowIndex + 1; r < rawRows.length; r++) {
        const row = rawRows[r];
        if (!Array.isArray(row) || row.length === 0) continue;

        const rawCourseId = colMap.courseId !== undefined ? row[colMap.courseId] : '';
        if (rawCourseId === null || rawCourseId === undefined) continue;
        const courseId = String(rawCourseId).trim();

        // Skip comments, empty rows, totals
        if (!courseId || courseId.startsWith('Ghi chú') || courseId.toLowerCase().includes('tổng')) {
          continue;
        }

        const rawCourseName = colMap.courseName !== undefined ? row[colMap.courseName] : '';
        const courseName = String(rawCourseName || '').trim();

        const rawSectionId = colMap.sectionId !== undefined ? row[colMap.sectionId] : '';
        const sectionId = String(rawSectionId || '').trim() || '01';

        const credits = colMap.credits !== undefined ? this.parseCredits(row[colMap.credits]) : 0;
        const lecturer = colMap.lecturer !== undefined ? String(row[colMap.lecturer] || '').trim() : '';
        const cohort = colMap.cohort !== undefined ? String(row[colMap.cohort] || '').trim() : '';
        const groupCode = colMap.groupCode !== undefined ? String(row[colMap.groupCode] || '').trim() : '';
        const room = colMap.room !== undefined ? String(row[colMap.room] || '').trim() : '';
        const day = colMap.day !== undefined ? this.parseDay(row[colMap.day]) : 2;

        // Parse Start Period & Period Count
        let startPeriod = 1;
        let periodCount = 2;

        if (colMap.startPeriod !== undefined && row[colMap.startPeriod] !== '') {
          startPeriod = parseInt(row[colMap.startPeriod], 10) || 1;
          if (colMap.periodCount !== undefined && row[colMap.periodCount] !== '') {
            periodCount = parseInt(row[colMap.periodCount], 10) || 1;
          } else if (colMap.endPeriod !== undefined && row[colMap.endPeriod] !== '') {
            const endPeriod = parseInt(row[colMap.endPeriod], 10) || startPeriod;
            periodCount = Math.max(1, endPeriod - startPeriod + 1);
          }
        } else if (colMap.period !== undefined && row[colMap.period] !== '') {
          const pStr = String(row[colMap.period]).trim();
          if (/[-–—]/.test(pStr)) {
            const parts = pStr.split(/[-–—]/);
            startPeriod = parseInt(parts[0], 10) || 1;
            const endP = parseInt(parts[1], 10) || startPeriod;
            periodCount = Math.max(1, endP - startPeriod + 1);
          } else {
            startPeriod = parseInt(pStr, 10) || 1;
            periodCount = 2;
          }
        }

        // Sanitize bounds
        if (startPeriod < 1) startPeriod = 1;
        if (periodCount < 1) periodCount = 1;

        const { startMinute, endMinute } = this.periodToMinutes(startPeriod, periodCount);

        // Determine session type ('Sáng', 'Chiều', 'Tối')
        let sessionType = 'Sáng';
        if (colMap.sessionType !== undefined && row[colMap.sessionType]) {
          const rawType = String(row[colMap.sessionType]).trim();
          if (rawType === 'Sáng' || rawType === 'Chiều' || rawType === 'Tối') {
            sessionType = rawType;
          } else {
            sessionType = this.periodToSessionType(startPeriod);
          }
        } else {
          sessionType = this.periodToSessionType(startPeriod);
        }

        // Parse Study Weeks
        const weeks = colMap.weeks !== undefined ? this.parseWeeks(row[colMap.weeks]) : Array.from({ length: 20 }, (_, i) => i + 1);

        // Determine Class Type ('LT', 'BT', 'LT+BT', 'TN')
        let classType = 'LT+BT';
        if (colMap.classType !== undefined && row[colMap.classType]) {
          classType = String(row[colMap.classType]).trim();
        } else {
          const lowerName = courseName.toLowerCase();
          if (lowerName.includes('thí nghiệm') || lowerName.includes('thực hành') || lowerName.includes('tn')) {
            classType = 'TN';
          }
        }

        const faculty = colMap.faculty !== undefined && row[colMap.faculty] ? String(row[colMap.faculty]).trim() : 'UED';

        const session = {
          day: day,
          startPeriod: startPeriod,
          periodCount: periodCount,
          startMinute: startMinute,
          endMinute: endMinute,
          sessionType: sessionType,
          room: room,
          weeks: weeks
        };

        if (!courses[courseId]) {
          courses[courseId] = {
            id: courseId,
            name: courseName,
            credits: credits,
            faculty: faculty,
            classes: []
          };
        }

        // Multi-session atomic grouping by composite key (courseId, sectionId)
        const secKey = `${courseId}__${sectionId}`;
        if (!classSections[secKey]) {
          const sectionObj = {
            id: sectionId,
            courseId: courseId,
            courseName: courseName,
            cohort: cohort,
            lecturer: lecturer,
            type: classType,
            groupCode: groupCode,
            sessions: [session]
          };
          classSections[secKey] = sectionObj;
          courses[courseId].classes.push(sectionObj);
        } else {
          // Additional weekly meeting session
          const existingSec = classSections[secKey];
          existingSec.sessions.push(session);
          if (lecturer && !existingSec.lecturer.includes(lecturer)) {
            existingSec.lecturer = existingSec.lecturer ? `${existingSec.lecturer}, ${lecturer}` : lecturer;
          }
        }

        rowCount++;
      }

      if (rowCount === 0) {
        throw new Error("Không tìm thấy hàng dữ liệu thời khóa biểu hợp lệ nào trong bảng tính.");
      }

      return {
        metadata: {
          semester: semesterMeta,
          school: schoolMeta,
          rowCount: rowCount,
          format: format
        },
        courses: courses
      };
    },

    /**
     * Parses an ArrayBuffer of an uploaded Excel file.
     */
    parseBuffer(arrayBuffer) {
      if (typeof XLSX === 'undefined') {
        throw new Error("Thư viện SheetJS chưa được nạp. Vui lòng kiểm tra lib/xlsx.full.min.js.");
      }
      let workbook;
      try {
        workbook = XLSX.read(arrayBuffer, { type: 'array' });
      } catch (err) {
        throw new Error("Không thể đọc tệp Excel. Vui lòng đảm bảo tệp có định dạng .xlsx, .xls hợp lệ.");
      }
      return this.parse(workbook);
    }
  };

  if (typeof window !== 'undefined') {
    window.Parser = Parser;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Parser;
  }
  if (typeof root !== 'undefined' && !root.Parser) {
    root.Parser = Parser;
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
