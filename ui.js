/**
 * ui.js - Timetable Scheduler UI Controller & Visualization Engine
 * Implements Features F01, F05-F16, F19-F35 for TKB HUST & UED.
 * Exposes pure helpers and controller API on window.UI (and window.TimetableUI).
 */
(function (root) {
  'use strict';

  const DAY_START_MINUTE = 405; // 06:45
  const DAY_END_MINUTE = 1050;  // 17:30
  const EVENING_END_MINUTE = 1260; // 21:00
  const BASE_GRID_HEIGHT_PX = 645; // 1px per minute at 1.0x zoom

  const DAY_NAMES = {
    2: 'Thứ 2',
    3: 'Thứ 3',
    4: 'Thứ 4',
    5: 'Thứ 5',
    6: 'Thứ 6',
    7: 'Thứ 7',
    8: 'Chủ Nhật'
  };

  const COURSE_COLORS = [
    '#4CAF50',
    '#2196F3',
    '#FF9800',
    '#E91E63',
    '#9C27B0',
    '#009688',
    '#3F51B5',
    '#795548'
  ];

  const RECENT_STORAGE_KEY = 'tkb_recent_courses_v1';
  const PREFS_STORAGE_KEY = 'tkb_display_prefs_v1';
  const MAX_RECENT_COURSES = 5;

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

  // ========================================================================
  // Pure Helper Functions (Unit-Testable)
  // ========================================================================

  /**
   * Escape HTML special characters to prevent DOM XSS when rendering untrusted strings.
   */
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Normalize Vietnamese diacritics to plain ASCII (case-preserving, NFD/NFC safe).
   */
  function removeVietnameseDiacritics(text) {
    if (text === null || text === undefined) return '';
    let s = String(text).normalize('NFD');
    s = s.replace(/[\u0300-\u036f]/g, '');
    s = s.replace(/[đĐ]/g, m => (m === 'Đ' ? 'D' : 'd'));
    return s.normalize('NFC');
  }

  function normalizeCoursesCollection(courses) {
    if (!courses) return [];
    if (Array.isArray(courses)) return courses;
    if (courses instanceof Map) return Array.from(courses.values());
    if (typeof courses === 'object') return Object.values(courses);
    return [];
  }

  /**
   * F07: Search courses by code or Vietnamese title (case-, Unicode NFD/NFC-, and diacritics-insensitive).
   * Code matches rank before name matches; ties broken by course.id ascending.
   */
  function searchCourses(courses, query, limit) {
    const maxItems = limit === undefined ? 10 : limit;
    if (!query || !String(query).trim()) return [];

    const qRaw = String(query).trim().normalize('NFC').toLowerCase();
    const qNorm = removeVietnameseDiacritics(qRaw);
    const list = normalizeCoursesCollection(courses);

    const matches = [];
    for (const c of list) {
      if (!c || !c.id) continue;
      const cCodeRaw = String(c.id).normalize('NFC').toLowerCase();
      const cCodeNorm = removeVietnameseDiacritics(cCodeRaw);
      const cNameRaw = String(c.name || '').normalize('NFC').toLowerCase();
      const cNameNorm = removeVietnameseDiacritics(cNameRaw);

      if (cCodeRaw.includes(qRaw) || cCodeNorm.includes(qNorm)) {
        matches.push({ priority: 0, course: c });
      } else if (cNameRaw.includes(qRaw) || cNameNorm.includes(qNorm)) {
        matches.push({ priority: 1, course: c });
      }
    }

    matches.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return String(a.course.id).localeCompare(String(b.course.id));
    });

    return matches.slice(0, maxItems).map(m => m.course);
  }

  /**
   * F11: Format running credit counter string.
   * Excludes disabled courses (enabled === false). Integers omit .0; decimals preserved.
   */
  function formatCreditCounter(selectedCourses) {
    const active = (selectedCourses || []).filter(c => c && c.enabled !== false);
    let totalCredits = 0;
    for (const c of active) {
      const cred = Number(c.credits);
      if (Number.isFinite(cred)) {
        totalCredits += cred;
      }
    }
    // Round to 2 decimal places to avoid IEEE 754 float noise (e.g., 1.5 + 1.5 = 3)
    const rounded = Math.round(totalCredits * 100) / 100;
    const credDisplay = Number.isInteger(rounded) ? String(rounded) : String(rounded);
    const activeCount = active.length;
    return {
      totalCredits: rounded,
      activeCount: activeCount,
      text: `Tổng số tín chỉ hiện tại: ${credDisplay} tín chỉ / ${activeCount} môn`
    };
  }

  function minuteToStr(minute) {
    const h = Math.floor(minute / 60);
    const m = minute % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  /**
   * F26: Calculate top & height percentage within the daily timetable grid.
   */
  function calculateSlotPosition(startMinute, endMinute, dayStartMinute, dayEndMinute) {
    const dStart = dayStartMinute !== undefined ? dayStartMinute : DAY_START_MINUTE;
    const dEnd = dayEndMinute !== undefined ? dayEndMinute : DAY_END_MINUTE;
    const totalMinutes = Math.max(1, dEnd - dStart);
    const topPct = ((startMinute - dStart) / totalMinutes) * 100;
    const heightPct = ((endMinute - startMinute) / totalMinutes) * 100;
    return {
      topPct: Math.round(topPct * 10000) / 10000,
      heightPct: Math.round(heightPct * 10000) / 10000
    };
  }

  /**
   * F27: Partition concurrent/overlapping sessions within a day column into fractional slices.
   */
  function partitionOverlappingSlots(sessions) {
    if (!Array.isArray(sessions) || sessions.length === 0) return [];

    const sorted = sessions.slice().sort((a, b) => {
      if (a.startMinute !== b.startMinute) return a.startMinute - b.startMinute;
      return b.endMinute - a.endMinute;
    });

    const clusters = [];
    let currentCluster = [];
    let clusterEnd = -1;

    for (const s of sorted) {
      if (currentCluster.length === 0) {
        currentCluster.push(s);
        clusterEnd = s.endMinute;
      } else if (s.startMinute < clusterEnd) {
        currentCluster.push(s);
        clusterEnd = Math.max(clusterEnd, s.endMinute);
      } else {
        clusters.push(currentCluster);
        currentCluster = [s];
        clusterEnd = s.endMinute;
      }
    }
    if (currentCluster.length > 0) {
      clusters.push(currentCluster);
    }

    const results = [];
    for (const cluster of clusters) {
      const n = cluster.length;
      const widthPct = 100 / n;
      for (let idx = 0; idx < n; idx++) {
        const leftPct = idx * widthPct;
        results.push({
          session: cluster[idx],
          widthPct: Math.round(widthPct * 100) / 100,
          leftPct: Math.round(leftPct * 100) / 100,
          clusterSize: n
        });
      }
    }
    return results;
  }

  /**
   * F28: Color theme classification ('yellow-orange' for Lab/TN/TH, 'green' for LT/BT).
   */
  function getClassColorTheme(classType) {
    const t = String(classType || '').toUpperCase();
    if (t.includes('TN') || t.includes('TH') || t.includes('LAB')) {
      return 'yellow-orange';
    }
    return 'green';
  }

  /**
   * Deterministic accent color per course ID.
   */
  function getCourseColor(courseId) {
    const s = String(courseId || '');
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) - hash) + s.charCodeAt(i);
      hash |= 0;
    }
    const idx = Math.abs(hash) % COURSE_COLORS.length;
    return COURSE_COLORS[idx];
  }

  /**
   * F29: Format study weeks cleanly (e.g., "Tuần 1-20" or "Tuần 1, 3, 5").
   */
  function formatWeeksDisplay(weeks) {
    if (!Array.isArray(weeks) || weeks.length === 0) return 'Tuần 1-20';
    const sorted = Array.from(new Set(weeks.map(Number).filter(Number.isFinite))).sort((a, b) => a - b);
    if (sorted.length === 0) return 'Tuần 1-20';
    if (sorted.length === 1) return `Tuần ${sorted[0]}`;

    // Check if contiguous range
    let contiguous = true;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] !== sorted[i - 1] + 1) {
        contiguous = false;
        break;
      }
    }
    if (contiguous) {
      return `Tuần ${sorted[0]}-${sorted[sorted.length - 1]}`;
    }

    // Group contiguous sub-ranges
    const ranges = [];
    let start = sorted[0];
    let prev = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === prev + 1) {
        prev = sorted[i];
      } else {
        ranges.push(start === prev ? String(start) : `${start}-${prev}`);
        start = sorted[i];
        prev = sorted[i];
      }
    }
    ranges.push(start === prev ? String(start) : `${start}-${prev}`);
    return `Tuần ${ranges.join(', ')}`;
  }

  function resolveSessionMinutes(session) {
    let startMin = (session && session.startMinute !== undefined && session.startMinute !== null && session.startMinute !== '' && Number.isFinite(Number(session.startMinute)))
      ? Number(session.startMinute)
      : undefined;
    let endMin = (session && session.endMinute !== undefined && session.endMinute !== null && session.endMinute !== '' && Number.isFinite(Number(session.endMinute)))
      ? Number(session.endMinute)
      : undefined;

    if (startMin === undefined || endMin === undefined) {
      const startP = (session && session.startPeriod) ? session.startPeriod : 1;
      const pCount = (session && session.periodCount) ? session.periodCount : 1;
      let fallback;
      if (root.Parser && typeof root.Parser.periodToMinutes === 'function') {
        fallback = root.Parser.periodToMinutes(startP, pCount);
      } else {
        const p = parseInt(startP, 10) || 1;
        const cnt = Math.max(1, parseInt(pCount, 10) || 1);
        const endP = p + cnt - 1;
        const sMin = PERIOD_FALLBACK[p] ? PERIOD_FALLBACK[p].start : 405 + (p - 1) * 50;
        const eMin = PERIOD_FALLBACK[endP] ? PERIOD_FALLBACK[endP].end : sMin + cnt * 50;
        fallback = { startMinute: sMin, endMinute: eMin };
      }
      if (startMin === undefined) startMin = fallback.startMinute;
      if (endMin === undefined) endMin = fallback.endMinute;
    }
    return { startMinute: startMin, endMinute: endMin };
  }

  /**
   * F29: Format Vietnamese session time string.
   */
  function formatSessionTimeText(session) {
    const d = parseInt(session && session.day, 10) || 2;
    const dayLabel = d === 8 ? 'Chủ Nhật' : `Thứ ${d}`;
    const startP = parseInt(session && session.startPeriod, 10) || 1;
    const pCount = parseInt(session && session.periodCount, 10) || 1;
    const endP = startP + pCount - 1;
    const mins = resolveSessionMinutes(session);
    const startStr = minuteToStr(mins.startMinute);
    const endStr = minuteToStr(mins.endMinute);
    return `${dayLabel}, Tiết ${startP}-${endP} (${startStr} - ${endStr})`;
  }

  /**
   * F32: Clamp zoom factor to [0.5, 1.5].
   */
  function clampZoom(factor) {
    const num = Number(factor);
    if (!Number.isFinite(num)) return 1.0;
    return Math.round(Math.max(0.5, Math.min(1.5, num)) * 100) / 100;
  }

  /**
   * F31: Determine visible day numbers (2..8) based on display preferences.
   */
  function getVisibleDays(prefs) {
    const hideWeekend = Boolean(prefs && prefs.hideWeekend);
    const days = [];
    for (let d = 2; d <= 8; d++) {
      if (hideWeekend && (d === 7 || d === 8)) continue;
      days.push(d);
    }
    return days;
  }

  // ========================================================================
  // Application State
  // ========================================================================

  const state = {
    dataset: null,
    isCustomDataset: false,
    selectedCourses: [],      // Array of cloned Course objects with explicit `enabled: boolean`
    recentCourseIds: [],      // Array of up to 5 course IDs
    excludedClasses: new Set(),  // Composite `${courseId}__${sectionId}`
    disabledSessions: new Set(), // e.g. 'T2_SANG', 'CN_CHIEU'
    allowAlternatingWeeks: false,
    avoidBackToBack: false,
    sortBy: 'Random',
    maxResults: 1000000,
    results: [],
    diagnostic: null,
    currentPage: 1,
    zoomFactor: 1.0,
    displayPrefs: {
      showRoom: true,
      showWeeks: false,
      adaptiveFont: true,
      hideWeekend: false
    },
    activeClassModalCourseId: null,
    searchHighlightIdx: -1,
    activeSearchResults: [],
    currentAbortController: null,
    activeSearchToken: 0,
    isSearching: false
  };

  // ========================================================================
  // Persistence Helpers (LocalStorage)
  // ========================================================================

  function loadRecentCoursesFromStorage() {
    try {
      if (typeof localStorage === 'undefined') return [];
      const raw = localStorage.getItem(RECENT_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter(id => typeof id === 'string' && id !== '__proto__' && !(id in Object.prototype)).slice(0, MAX_RECENT_COURSES)
        : [];
    } catch (e) {
      return [];
    }
  }

  function saveRecentCoursesToStorage() {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(state.recentCourseIds));
    } catch (e) {
      // Ignore storage errors
    }
  }

  function loadPrefsFromStorage() {
    try {
      if (typeof localStorage === 'undefined') return;
      const raw = localStorage.getItem(PREFS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        state.displayPrefs = {
          showRoom: parsed.showRoom !== undefined ? Boolean(parsed.showRoom) : true,
          showWeeks: parsed.showWeeks !== undefined ? Boolean(parsed.showWeeks) : false,
          adaptiveFont: parsed.adaptiveFont !== undefined ? Boolean(parsed.adaptiveFont) : true,
          hideWeekend: parsed.hideWeekend !== undefined ? Boolean(parsed.hideWeekend) : false
        };
      }
    } catch (e) {
      // Ignore storage errors
    }
  }

  function savePrefsToStorage() {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(state.displayPrefs));
    } catch (e) {
      // Ignore storage errors
    }
  }

  // ========================================================================
  // DOM Helpers & Toast
  // ========================================================================

  function $(id) {
    return typeof document !== 'undefined' ? document.getElementById(id) : null;
  }

  function showToast(message, type) {
    const container = $('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type || 'info'}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 3200);
  }

  function getCourseById(courseId) {
    if (!state.dataset || !state.dataset.courses || courseId === null || courseId === undefined) return null;
    if (state.dataset.courses instanceof Map) {
      return state.dataset.courses.get(courseId) || null;
    }
    const key = String(courseId);
    if (!Object.prototype.hasOwnProperty.call(state.dataset.courses, key)) {
      return null;
    }
    return state.dataset.courses[key] || null;
  }

  // ========================================================================
  // F09: Recent Courses Management
  // ========================================================================

  function addRecentCourse(courseId) {
    if (!courseId) return state.recentCourseIds;
    const id = String(courseId);
    if (id === '__proto__' || (id in Object.prototype)) {
      return state.recentCourseIds;
    }
    state.recentCourseIds = state.recentCourseIds.filter(x => x !== id);
    state.recentCourseIds.unshift(id);
    if (state.recentCourseIds.length > MAX_RECENT_COURSES) {
      state.recentCourseIds = state.recentCourseIds.slice(0, MAX_RECENT_COURSES);
    }
    saveRecentCoursesToStorage();
    renderRecentCourses();
    return state.recentCourseIds;
  }

  function getRecentCourses() {
    return state.recentCourseIds.slice();
  }

  function renderRecentCourses() {
    const wrapper = $('recentCoursesWrapper');
    const listEl = $('recentCoursesList');
    if (!wrapper || !listEl) return;

    const validIds = state.recentCourseIds.filter(id => Boolean(getCourseById(id)));
    if (validIds.length === 0) {
      wrapper.classList.add('hidden');
      listEl.innerHTML = '';
      return;
    }

    wrapper.classList.remove('hidden');
    listEl.innerHTML = '';
    for (const id of validIds) {
      const course = getCourseById(id);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'recent-chip';
      chip.textContent = `${course.id} - ${course.name}`;
      chip.title = `Thêm nhanh ${course.name}`;
      chip.addEventListener('click', () => {
        selectCourse(course.id);
      });
      listEl.appendChild(chip);
    }
  }

  // ========================================================================
  // F10, F11, F12: Course Selection, Credit Counter & Cards
  // ========================================================================

  function selectCourse(courseId) {
    const rawCourse = getCourseById(courseId);
    if (!rawCourse) return false;

    if (!rawCourse.classes || rawCourse.classes.length === 0) {
      showToast(`Học phần "${rawCourse.name}" (${rawCourse.id}) không mở lớp trong kỳ này.`, 'warning');
      addRecentCourse(rawCourse.id);
      return false;
    }

    if (state.selectedCourses.some(c => c.id === rawCourse.id)) {
      showToast(`Học phần ${rawCourse.id} đã có trong danh sách đã chọn.`, 'warning');
      return false;
    }

    const cloned = Object.assign({}, rawCourse, { enabled: true });
    state.selectedCourses.push(cloned);
    addRecentCourse(rawCourse.id);
    state.currentPage = 1;
    renderSelectedCourses();
    renderCreditCounter();
    renderAllOutputs();
    return true;
  }

  function removeCourse(courseId) {
    const beforeLen = state.selectedCourses.length;
    state.selectedCourses = state.selectedCourses.filter(c => c.id !== courseId);
    if (state.selectedCourses.length !== beforeLen) {
      // Clean exclusions for removed course
      for (const key of Array.from(state.excludedClasses)) {
        if (key.startsWith(`${courseId}__`)) {
          state.excludedClasses.delete(key);
        }
      }
      state.results = [];
      state.diagnostic = null;
      state.currentPage = 1;
      renderSelectedCourses();
      renderCreditCounter();
      renderAllOutputs();
    }
  }

  function clearAllCourses() {
    state.selectedCourses = [];
    state.excludedClasses.clear();
    state.results = [];
    state.diagnostic = null;
    state.currentPage = 1;
    renderSelectedCourses();
    renderCreditCounter();
    renderAllOutputs();
  }

  function toggleCourseEnabled(courseId) {
    const course = state.selectedCourses.find(c => c.id === courseId);
    if (!course) return false;
    course.enabled = course.enabled === false ? true : false;
    state.currentPage = 1;
    renderSelectedCourses();
    renderCreditCounter();
    renderAllOutputs();
    return course.enabled;
  }

  function renderCreditCounter() {
    const el = $('creditCounter');
    if (!el) return;
    const summary = formatCreditCounter(state.selectedCourses);
    el.textContent = summary.text;
  }

  function getActiveSectionCountForCourse(course) {
    if (!course || !Array.isArray(course.classes)) return 0;
    let count = 0;
    for (const sec of course.classes) {
      const compKey = `${course.id}__${sec.id}`;
      if (!state.excludedClasses.has(compKey) && !state.excludedClasses.has(sec.id)) {
        count++;
      }
    }
    return count;
  }

  function courseHasLab(course) {
    if (!course || !Array.isArray(course.classes)) return false;
    return course.classes.some(sec => getClassColorTheme(sec.type) === 'yellow-orange');
  }

  function renderSelectedCourses() {
    const grid = $('selectedCoursesGrid');
    const clearBtn = $('clearAllCoursesBtn');
    if (!grid) return;

    if (clearBtn) {
      clearBtn.classList.toggle('hidden', state.selectedCourses.length === 0);
    }

    if (state.selectedCourses.length === 0) {
      grid.innerHTML = '<div class="empty-state-small">Chưa chọn học phần nào. Hãy tìm và thêm môn học ở trên.</div>';
      return;
    }

    grid.innerHTML = '';
    for (const course of state.selectedCourses) {
      const isDisabled = course.enabled === false;
      const activeSecCount = getActiveSectionCountForCourse(course);
      const totalSecCount = course.classes ? course.classes.length : 0;
      const color = getCourseColor(course.id);

      const card = document.createElement('div');
      card.className = `course-card${isDisabled ? ' disabled' : ''}`;
      card.dataset.courseId = course.id;

      const accent = document.createElement('div');
      accent.className = 'course-card-accent';
      accent.style.backgroundColor = color;
      card.appendChild(accent);

      const top = document.createElement('div');
      top.className = 'course-card-top';

      const codeSpan = document.createElement('span');
      codeSpan.className = 'course-card-code';
      codeSpan.textContent = course.id;

      const credSpan = document.createElement('span');
      credSpan.className = 'badge badge-primary';
      const cVal = Number(course.credits) || 0;
      credSpan.textContent = `${cVal} TC`;

      top.appendChild(codeSpan);
      top.appendChild(credSpan);
      card.appendChild(top);

      const title = document.createElement('div');
      title.className = 'course-card-title';
      title.textContent = course.name;
      title.title = course.name;
      card.appendChild(title);

      const badges = document.createElement('div');
      badges.className = 'course-card-badges';

      const secBadge = document.createElement('span');
      secBadge.className = 'badge badge-neutral';
      secBadge.textContent = `${activeSecCount}/${totalSecCount} lớp`;
      badges.appendChild(secBadge);

      if (course.faculty) {
        const facBadge = document.createElement('span');
        facBadge.className = 'badge badge-green';
        facBadge.textContent = course.faculty;
        badges.appendChild(facBadge);
      }

      if (courseHasLab(course)) {
        const labBadge = document.createElement('span');
        labBadge.className = 'badge badge-lab';
        labBadge.textContent = 'Có TN';
        badges.appendChild(labBadge);
      }

      if (totalSecCount === 0) {
        const unopenBadge = document.createElement('span');
        unopenBadge.className = 'badge badge-unopened';
        unopenBadge.textContent = 'Không mở kỳ này';
        badges.appendChild(unopenBadge);
      }

      card.appendChild(badges);

      const actions = document.createElement('div');
      actions.className = 'course-card-actions';

      const selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'course-card-btn btn-choose-classes';
      selectBtn.textContent = 'Chọn cụ thể các lớp';
      selectBtn.addEventListener('click', () => openClassModal(course.id));

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = `course-card-btn btn-toggle-enable${isDisabled ? ' is-disabled' : ''}`;
      toggleBtn.textContent = isDisabled ? 'Bật lại' : 'Tạm ẩn';
      toggleBtn.addEventListener('click', () => toggleCourseEnabled(course.id));

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'course-card-btn btn-remove-course';
      removeBtn.textContent = 'Xóa môn học';
      removeBtn.addEventListener('click', () => removeCourse(course.id));

      actions.appendChild(selectBtn);
      actions.appendChild(toggleBtn);
      actions.appendChild(removeBtn);
      card.appendChild(actions);

      grid.appendChild(card);
    }
  }

  // ========================================================================
  // F13: Specific Class Selection Modal
  // ========================================================================

  function isSectionExcluded(courseId, sectionId) {
    return state.excludedClasses.has(`${courseId}__${sectionId}`);
  }

  function toggleSectionExclusion(courseId, sectionId) {
    const key = `${courseId}__${sectionId}`;
    if (state.excludedClasses.has(key)) {
      state.excludedClasses.delete(key);
    } else {
      state.excludedClasses.add(key);
    }
    state.currentPage = 1;
    renderSelectedCourses();
    if (state.activeClassModalCourseId === courseId) {
      renderClassModalBody(courseId);
    }
    renderAllOutputs();
  }

  function selectAllClassesForCourse(courseId) {
    const course = state.selectedCourses.find(c => c.id === courseId) || getCourseById(courseId);
    if (!course) return;
    for (const sec of (course.classes || [])) {
      state.excludedClasses.delete(`${course.id}__${sec.id}`);
    }
    state.currentPage = 1;
    renderSelectedCourses();
    if (state.activeClassModalCourseId === courseId) {
      renderClassModalBody(courseId);
    }
    renderAllOutputs();
  }

  function deselectAllClassesForCourse(courseId) {
    const course = state.selectedCourses.find(c => c.id === courseId) || getCourseById(courseId);
    if (!course) return;
    for (const sec of (course.classes || [])) {
      state.excludedClasses.add(`${course.id}__${sec.id}`);
    }
    state.currentPage = 1;
    renderSelectedCourses();
    if (state.activeClassModalCourseId === courseId) {
      renderClassModalBody(courseId);
    }
    renderAllOutputs();
  }

  function openClassModal(courseId) {
    const course = state.selectedCourses.find(c => c.id === courseId) || getCourseById(courseId);
    const modal = $('classSelectModal');
    if (!course || !modal) return;

    state.activeClassModalCourseId = course.id;
    const titleEl = $('classSelectModalTitle');
    const subEl = $('classSelectModalSubtitle');
    if (titleEl) titleEl.textContent = `Chọn cụ thể các lớp — ${course.name}`;
    if (subEl) subEl.textContent = `Mã HP: ${course.id} · ${course.credits} tín chỉ`;

    renderClassModalBody(course.id);
    modal.classList.remove('hidden');
  }

  function renderClassModalBody(courseId) {
    const course = state.selectedCourses.find(c => c.id === courseId) || getCourseById(courseId);
    const body = $('classSelectModalBody');
    const countLabel = $('modalSelectedCount');
    if (!course || !body) return;

    const sections = course.classes || [];
    const activeCount = getActiveSectionCountForCourse(course);
    if (countLabel) {
      countLabel.textContent = `Đang chọn ${activeCount} / ${sections.length} lớp`;
    }

    if (sections.length === 0) {
      body.innerHTML = '<div class="empty-state-small">Không mở kỳ này</div>';
      return;
    }

    // Group sections by type (LT, BT, LT+BT, TN, etc.)
    const groups = new Map();
    for (const sec of sections) {
      const typeKey = sec.type || 'Khác';
      if (!groups.has(typeKey)) groups.set(typeKey, []);
      groups.get(typeKey).push(sec);
    }

    body.innerHTML = '';
    for (const [typeName, groupSections] of groups.entries()) {
      const groupDiv = document.createElement('div');
      groupDiv.className = 'class-type-group';

      const header = document.createElement('div');
      header.className = 'class-type-group-header';
      header.textContent = `Loại lớp: ${typeName} (${groupSections.length} lớp)`;
      groupDiv.appendChild(header);

      for (const sec of groupSections) {
        const row = document.createElement('label');
        row.className = 'class-option-row';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !isSectionExcluded(course.id, sec.id);
        cb.dataset.sectionId = sec.id;
        cb.addEventListener('change', () => {
          toggleSectionExclusion(course.id, sec.id);
        });

        const info = document.createElement('div');
        info.className = 'class-option-info';

        const head = document.createElement('div');
        head.className = 'class-option-head';

        const idTag = document.createElement('strong');
        idTag.textContent = sec.id;
        head.appendChild(idTag);

        const themeBadge = document.createElement('span');
        themeBadge.className = `badge ${getClassColorTheme(sec.type) === 'yellow-orange' ? 'badge-lab' : 'badge-green'}`;
        themeBadge.textContent = sec.type || 'LT';
        head.appendChild(themeBadge);

        if (sec.cohort) {
          const cohortSpan = document.createElement('span');
          cohortSpan.className = 'badge badge-neutral';
          cohortSpan.textContent = sec.cohort;
          head.appendChild(cohortSpan);
        }

        const lecSpan = document.createElement('span');
        lecSpan.className = 'muted-text';
        lecSpan.textContent = `GV: ${sec.lecturer || 'Chưa phân công'}`;
        head.appendChild(lecSpan);

        info.appendChild(head);

        const sessList = document.createElement('div');
        sessList.className = 'class-option-sessions';
        for (const s of (sec.sessions || [])) {
          const item = document.createElement('div');
          item.textContent = `• ${formatSessionTimeText(s)} | Phòng: ${s.room || 'N/A'} | ${formatWeeksDisplay(s.weeks)}`;
          sessList.appendChild(item);
        }
        info.appendChild(sessList);

        row.appendChild(cb);
        row.appendChild(info);
        groupDiv.appendChild(row);
      }

      body.appendChild(groupDiv);
    }
  }

  // ========================================================================
  // F07 & F08: Autocomplete Dropdown Rendering
  // ========================================================================

  function hideSearchDropdown() {
    const dropdown = $('searchDropdown');
    const input = $('courseSearchInput');
    if (dropdown) dropdown.classList.add('hidden');
    if (input) input.setAttribute('aria-expanded', 'false');
    state.searchHighlightIdx = -1;
  }

  function renderSearchDropdown(matches) {
    const dropdown = $('searchDropdown');
    const input = $('courseSearchInput');
    if (!dropdown || !input) return;

    state.activeSearchResults = matches;
    state.searchHighlightIdx = matches.length > 0 ? 0 : -1;

    if (matches.length === 0) {
      if (input.value.trim()) {
        dropdown.innerHTML = '<li class="search-dropdown-item"><span class="muted-text">Không tìm thấy học phần phù hợp</span></li>';
        dropdown.classList.remove('hidden');
        input.setAttribute('aria-expanded', 'true');
      } else {
        hideSearchDropdown();
      }
      return;
    }

    dropdown.innerHTML = '';
    matches.forEach((course, idx) => {
      const isUnopened = !course.classes || course.classes.length === 0;
      const li = document.createElement('li');
      li.className = `search-dropdown-item${idx === state.searchHighlightIdx ? ' active' : ''}${isUnopened ? ' unopened' : ''}`;
      li.setAttribute('role', 'option');
      li.dataset.courseId = course.id;

      const main = document.createElement('div');
      main.className = 'search-item-main';

      const code = document.createElement('span');
      code.className = 'search-item-code';
      code.textContent = course.id;

      const name = document.createElement('span');
      name.className = 'search-item-name';
      name.textContent = course.name;

      main.appendChild(code);
      main.appendChild(name);

      const meta = document.createElement('div');
      meta.className = 'search-item-meta';

      const credBadge = document.createElement('span');
      credBadge.className = 'badge badge-primary';
      credBadge.textContent = `${Number(course.credits) || 0} TC`;
      meta.appendChild(credBadge);

      if (isUnopened) {
        const unBadge = document.createElement('span');
        unBadge.className = 'badge badge-unopened';
        unBadge.textContent = 'Không mở kỳ này';
        meta.appendChild(unBadge);
      } else {
        const secBadge = document.createElement('span');
        secBadge.className = 'badge badge-neutral';
        secBadge.textContent = `${course.classes.length} lớp`;
        meta.appendChild(secBadge);
      }

      li.appendChild(main);
      li.appendChild(meta);

      li.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        selectCourse(course.id);
        input.value = '';
        const clearBtn = $('clearSearchBtn');
        if (clearBtn) clearBtn.classList.add('hidden');
        hideSearchDropdown();
      });

      dropdown.appendChild(li);
    });

    dropdown.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
  }

  function updateDropdownHighlight() {
    const dropdown = $('searchDropdown');
    if (!dropdown) return;
    const items = dropdown.querySelectorAll('.search-dropdown-item[data-course-id]');
    items.forEach((el, idx) => {
      el.classList.toggle('active', idx === state.searchHighlightIdx);
      if (idx === state.searchHighlightIdx && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  // ========================================================================
  // Scheduler Execution (F16 - F24)
  // ========================================================================

  function updateProgressUI(data) {
    const fill = $('progressBarFill');
    const searchedEl = $('progressSearchedCount');
    const foundEl = $('progressFoundCount');
    const pctEl = $('progressPercentLabel');
    if (fill) fill.style.width = `${data.progress || 0}%`;
    if (searchedEl) searchedEl.textContent = String(data.searched || 0);
    if (foundEl) foundEl.textContent = String(data.found || 0);
    if (pctEl) pctEl.textContent = `${data.progress || 0}%`;
  }

  async function runScheduler() {
    if (!root.Scheduler) {
      showToast('Chưa tải module Scheduler.', 'error');
      return null;
    }

    if (state.isSearching && state.currentAbortController) {
      state.currentAbortController.abort();
    }

    const activeCourses = state.selectedCourses.filter(c => c.enabled !== false);
    if (activeCourses.length === 0) {
      state.activeSearchToken++;
      state.currentAbortController = null;
      state.isSearching = false;
      state.results = [];
      state.diagnostic = null;
      state.currentPage = 1;
      renderAllOutputs();
      const progressModalEmpty = $('progressModal');
      if (progressModalEmpty) progressModalEmpty.classList.add('hidden');
      showToast('Vui lòng chọn ít nhất 1 học phần đang bật để xếp lịch.', 'warning');
      return { totalCombinationsSearched: 0, results: [], diagnostic: null };
    }

    const abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const searchToken = ++state.activeSearchToken;
    state.currentAbortController = abortController;
    state.isSearching = true;

    const progressModal = $('progressModal');
    if (progressModal) {
      updateProgressUI({ searched: 0, found: 0, progress: 0 });
      progressModal.classList.remove('hidden');
    }

    const options = {
      disabledSessions: state.disabledSessions,
      excludedClasses: state.excludedClasses,
      allowAlternatingWeeks: state.allowAlternatingWeeks,
      avoidBackToBack: state.avoidBackToBack,
      maxResults: state.maxResults,
      sortBy: state.sortBy,
      signal: abortController ? abortController.signal : undefined
    };

    try {
      const output = await root.Scheduler.generate(state.selectedCourses, options, (prog) => {
        if (state.activeSearchToken === searchToken && state.currentAbortController === abortController) {
          updateProgressUI(prog);
        }
      });

      if (state.activeSearchToken !== searchToken || state.currentAbortController !== abortController) {
        return output;
      }

      state.results = output.results || [];
      state.diagnostic = output.diagnostic || null;
      state.currentPage = 1;
      renderAllOutputs();

      if (state.results.length > 0) {
        showToast(`Đã tìm thấy ${state.results.length} phương án thời khóa biểu.`, 'success');
      } else if (state.diagnostic) {
        showToast(state.diagnostic.title || 'Không tìm thấy phương án phù hợp.', 'warning');
      }
      return output;
    } finally {
      if (state.activeSearchToken === searchToken && state.currentAbortController === abortController) {
        state.isSearching = false;
        state.currentAbortController = null;
        if (progressModal) {
          progressModal.classList.add('hidden');
        }
      }
    }
  }

  // ========================================================================
  // Outputs Rendering: Diagnostics (F24), Reg Bar (F30), Pagination (F33), Grid (F25-F28)
  // ========================================================================

  function getActiveOption() {
    if (!state.results || state.results.length === 0) return null;
    const idx = Math.max(0, Math.min(state.results.length - 1, state.currentPage - 1));
    return state.results[idx] || null;
  }

  function renderDiagnosticBanner() {
    const banner = $('diagnosticBanner');
    const titleEl = $('diagnosticTitle');
    const detailsEl = $('diagnosticDetails');
    const coursesEl = $('diagnosticCourses');
    if (!banner) return;

    if (!state.diagnostic || state.results.length > 0) {
      banner.classList.add('hidden');
      return;
    }

    banner.classList.remove('hidden');
    if (titleEl) {
      titleEl.textContent = `[${state.diagnostic.code}] ${state.diagnostic.title}`;
    }
    if (detailsEl) {
      detailsEl.textContent = state.diagnostic.details || '';
    }
    if (coursesEl) {
      coursesEl.innerHTML = '';
      for (const cid of (state.diagnostic.conflictingCourses || [])) {
        const c = getCourseById(cid);
        const pill = document.createElement('span');
        pill.className = 'badge badge-unopened';
        pill.textContent = c ? `${c.id} - ${c.name}` : cid;
        coursesEl.appendChild(pill);
      }
    }
  }

  function renderRegistrationBar() {
    const listEl = $('regCodesList');
    const copyCommaBtn = $('copyCommaBtn');
    const copyNewlineBtn = $('copyNewlineBtn');
    if (!listEl) return;

    const opt = getActiveOption();
    if (!opt || !opt.classes || opt.classes.length === 0) {
      listEl.innerHTML = '<span class="muted-text">Chưa có phương án nào</span>';
      if (copyCommaBtn) copyCommaBtn.disabled = true;
      if (copyNewlineBtn) copyNewlineBtn.disabled = true;
      return;
    }

    listEl.innerHTML = '';
    for (const sec of opt.classes) {
      const pill = document.createElement('span');
      pill.className = 'reg-code-pill';
      pill.textContent = sec.id;
      pill.title = `${sec.courseId} - ${sec.courseName}`;
      listEl.appendChild(pill);
    }

    if (copyCommaBtn) copyCommaBtn.disabled = false;
    if (copyNewlineBtn) copyNewlineBtn.disabled = false;
  }

  function renderPaginationAndExports() {
    const total = state.results.length;
    const prevBtn = $('prevPageBtn');
    const nextBtn = $('nextPageBtn');
    const resetBtn = $('resetPageBtn');
    const jumpInput = $('pageJumpInput');
    const totalLabel = $('totalPagesLabel');
    const metricsBadge = $('activeMetricsBadge');
    const exportPngBtn = $('exportPngBtn');
    const exportExcelBtn = $('exportExcelBtn');
    const exportIcalBtn = $('exportIcalBtn');

    if (total === 0) {
      state.currentPage = 1;
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      if (resetBtn) resetBtn.disabled = true;
      if (jumpInput) {
        jumpInput.disabled = true;
        jumpInput.value = '0';
      }
      if (totalLabel) totalLabel.textContent = '/ 0';
      if (metricsBadge) metricsBadge.classList.add('hidden');
      if (exportPngBtn) exportPngBtn.disabled = true;
      if (exportExcelBtn) exportExcelBtn.disabled = true;
      if (exportIcalBtn) exportIcalBtn.disabled = true;
      return;
    }

    state.currentPage = Math.max(1, Math.min(total, state.currentPage));
    if (prevBtn) prevBtn.disabled = state.currentPage <= 1;
    if (nextBtn) nextBtn.disabled = state.currentPage >= total;
    if (resetBtn) resetBtn.disabled = state.currentPage <= 1;
    if (jumpInput) {
      jumpInput.disabled = false;
      jumpInput.min = '1';
      jumpInput.max = String(total);
      jumpInput.value = String(state.currentPage);
    }
    if (totalLabel) totalLabel.textContent = `/ ${total}`;

    const opt = getActiveOption();
    if (metricsBadge && opt && opt.metrics) {
      metricsBadge.classList.remove('hidden');
      metricsBadge.textContent =
        `Sáng nghỉ: ${opt.metrics.freeMornings} | Chiều nghỉ: ${opt.metrics.freeAfternoons} | Ngày nghỉ trọn: ${opt.metrics.freeFullDays}`;
    }

    if (exportPngBtn) exportPngBtn.disabled = false;
    if (exportExcelBtn) exportExcelBtn.disabled = false;
    if (exportIcalBtn) exportIcalBtn.disabled = false;
  }

  function setPage(pageNumber) {
    const total = state.results.length;
    if (total === 0) {
      state.currentPage = 1;
      return 1;
    }
    const target = Math.max(1, Math.min(total, parseInt(pageNumber, 10) || 1));
    state.currentPage = target;
    renderPaginationAndExports();
    renderRegistrationBar();
    renderTimetableGrid();
    return target;
  }

  function setZoom(factor) {
    state.zoomFactor = clampZoom(factor);
    const slider = $('zoomSlider');
    const label = $('zoomValueLabel');
    if (slider) slider.value = String(state.zoomFactor);
    if (label) label.textContent = `${Math.round(state.zoomFactor * 100)}%`;

    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.style.setProperty('--zoom-scale', String(state.zoomFactor));
    }
    renderTimetableGrid();
    return state.zoomFactor;
  }

  function updateDisplayPrefs(partial) {
    if (partial && typeof partial === 'object') {
      state.displayPrefs = Object.assign({}, state.displayPrefs, partial);
      savePrefsToStorage();
      syncCustomizerCheckboxes();
      renderTimetableGrid();
    }
    return Object.assign({}, state.displayPrefs);
  }

  function syncCustomizerCheckboxes() {
    const showRoomCb = $('prefShowRoom');
    const showWeeksCb = $('prefShowWeeks');
    const adaptiveCb = $('prefAdaptiveFont');
    const hideWeekendCb = $('prefHideWeekend');
    if (showRoomCb) showRoomCb.checked = Boolean(state.displayPrefs.showRoom);
    if (showWeeksCb) showWeeksCb.checked = Boolean(state.displayPrefs.showWeeks);
    if (adaptiveCb) adaptiveCb.checked = Boolean(state.displayPrefs.adaptiveFont);
    if (hideWeekendCb) hideWeekendCb.checked = Boolean(state.displayPrefs.hideWeekend);
  }

  /**
   * F25 - F29: Render Weekly Timetable Grid
   */
  function renderTimetableGrid() {
    const gridEl = $('timetableGrid');
    if (!gridEl) return;

    gridEl.classList.toggle('font-adaptive', Boolean(state.displayPrefs.adaptiveFont));
    gridEl.classList.toggle('font-fixed', !state.displayPrefs.adaptiveFont);

    const opt = getActiveOption();
    const visibleDays = getVisibleDays(state.displayPrefs);
    const colTemplate = `92px repeat(${visibleDays.length}, minmax(105px, 1fr))`;

    // Determine if evening periods (13-16) are needed
    let hasEvening = false;
    if (opt && Array.isArray(opt.classes)) {
      for (const sec of opt.classes) {
        for (const s of (sec.sessions || [])) {
          const mins = resolveSessionMinutes(s);
          const startP = parseInt(s.startPeriod, 10) || 1;
          const pCount = parseInt(s.periodCount, 10) || 1;
          if (mins.endMinute > DAY_END_MINUTE || (startP + pCount - 1 > 12)) {
            hasEvening = true;
            break;
          }
        }
        if (hasEvening) break;
      }
    }

    const dayEndMin = hasEvening ? EVENING_END_MINUTE : DAY_END_MINUTE;
    const totalMinutes = dayEndMin - DAY_START_MINUTE;
    const bodyHeightPx = Math.round(totalMinutes * state.zoomFactor);

    gridEl.innerHTML = '';

    // Header Row
    const headerRow = document.createElement('div');
    headerRow.className = 'timetable-header-row';
    headerRow.style.gridTemplateColumns = colTemplate;

    const timeHeader = document.createElement('div');
    timeHeader.className = 'timetable-time-col-header';
    timeHeader.textContent = 'Tiết / Giờ';
    headerRow.appendChild(timeHeader);

    for (const d of visibleDays) {
      const dayHead = document.createElement('div');
      dayHead.className = 'timetable-day-header';
      dayHead.dataset.day = String(d);
      dayHead.textContent = DAY_NAMES[d] || `Thứ ${d}`;
      headerRow.appendChild(dayHead);
    }
    gridEl.appendChild(headerRow);

    // Body Container
    const bodyEl = document.createElement('div');
    bodyEl.className = 'timetable-body';
    bodyEl.style.gridTemplateColumns = colTemplate;
    bodyEl.style.height = `${bodyHeightPx}px`;

    // Left Time Axis
    const timeAxis = document.createElement('div');
    timeAxis.className = 'timetable-time-axis';

    const periodTimes = (root.Parser && root.Parser.PERIOD_TIMES) ? root.Parser.PERIOD_TIMES : {};
    const maxPeriod = hasEvening ? 16 : 12;

    for (let p = 1; p <= maxPeriod; p++) {
      const pt = periodTimes[p] || { start: 405 + (p - 1) * 50, end: 450 + (p - 1) * 50 };
      const pos = calculateSlotPosition(pt.start, pt.end, DAY_START_MINUTE, dayEndMin);
      const mark = document.createElement('div');
      mark.className = 'period-axis-mark';
      mark.style.top = `${pos.topPct}%`;
      mark.style.height = `${pos.heightPct}%`;
      mark.innerHTML = `<strong>Tiết ${p}</strong><span>${minuteToStr(pt.start)}-${minuteToStr(pt.end)}</span>`;
      timeAxis.appendChild(mark);
    }

    // Lunch Break Band (11:45 - 12:30 -> minutes 705..750)
    const lunchPos = calculateSlotPosition(705, 750, DAY_START_MINUTE, dayEndMin);
    const lunchBand = document.createElement('div');
    lunchBand.className = 'lunch-break-band';
    lunchBand.style.top = `${lunchPos.topPct}%`;
    lunchBand.style.height = `${lunchPos.heightPct}%`;
    lunchBand.textContent = 'Nghỉ trưa';
    timeAxis.appendChild(lunchBand);

    bodyEl.appendChild(timeAxis);

    // Collect sessions per day
    const sessionsByDay = new Map();
    for (const d of visibleDays) sessionsByDay.set(d, []);

    if (opt && Array.isArray(opt.classes)) {
      for (const sec of opt.classes) {
        for (const s of (sec.sessions || [])) {
          const d = parseInt(s.day, 10);
          if (sessionsByDay.has(d)) {
            const mins = resolveSessionMinutes(s);
            sessionsByDay.get(d).push({
              sec: sec,
              session: s,
              startMinute: mins.startMinute,
              endMinute: mins.endMinute
            });
          }
        }
      }
    }

    // Render Day Columns
    for (const d of visibleDays) {
      const dayCol = document.createElement('div');
      dayCol.className = 'timetable-day-col';
      dayCol.dataset.day = String(d);

      // Period horizontal guides
      for (let p = 1; p <= maxPeriod; p++) {
        const pt = periodTimes[p] || { start: 405 + (p - 1) * 50, end: 450 + (p - 1) * 50 };
        const pos = calculateSlotPosition(pt.start, pt.end, DAY_START_MINUTE, dayEndMin);
        const guide = document.createElement('div');
        guide.className = 'grid-hour-guide';
        guide.style.top = `${pos.topPct}%`;
        dayCol.appendChild(guide);
      }

      // Lunch overlay band across day column
      const dayLunch = document.createElement('div');
      dayLunch.className = 'day-lunch-overlay';
      dayLunch.style.top = `${lunchPos.topPct}%`;
      dayLunch.style.height = `${lunchPos.heightPct}%`;
      dayCol.appendChild(dayLunch);

      // Partition overlapping/alternating sessions
      const rawDayEntries = sessionsByDay.get(d);
      const partitioned = partitionOverlappingSlots(rawDayEntries);

      for (const item of partitioned) {
        const entry = item.session;
        const sec = entry.sec;
        const s = entry.session;

        const pos = calculateSlotPosition(entry.startMinute, entry.endMinute, DAY_START_MINUTE, dayEndMin);
        const theme = getClassColorTheme(sec.type);

        const block = document.createElement('div');
        block.className = `class-block ${theme === 'yellow-orange' ? 'theme-lab' : 'theme-regular'}${item.clusterSize > 1 ? ' compact-block' : ''}`;
        block.style.top = `${pos.topPct}%`;
        block.style.height = `${pos.heightPct}%`;
        block.style.left = `${item.leftPct}%`;
        block.style.width = `${item.widthPct}%`;
        block.dataset.courseId = sec.courseId;
        block.dataset.sectionId = sec.id;
        block.title = `${sec.courseName} (${sec.id}) — Bấm để xem chi tiết`;

        const titleDiv = document.createElement('div');
        titleDiv.className = 'class-block-title';
        titleDiv.textContent = sec.courseName || sec.courseId;
        block.appendChild(titleDiv);

        const metaDiv = document.createElement('div');
        metaDiv.className = 'class-block-meta';

        const idLine = document.createElement('div');
        idLine.className = 'class-block-id';
        idLine.textContent = `${sec.id} (${sec.type || 'LT'})`;
        metaDiv.appendChild(idLine);

        if (state.displayPrefs.showRoom && s.room) {
          const roomLine = document.createElement('div');
          roomLine.className = 'class-block-room';
          roomLine.textContent = `Phòng: ${s.room}`;
          metaDiv.appendChild(roomLine);
        }

        if (state.displayPrefs.showWeeks) {
          const weeksLine = document.createElement('div');
          weeksLine.className = 'class-block-weeks';
          weeksLine.textContent = formatWeeksDisplay(s.weeks);
          metaDiv.appendChild(weeksLine);
        }

        block.appendChild(metaDiv);
        block.addEventListener('click', () => openClassDetailModal(sec));
        dayCol.appendChild(block);
      }

      bodyEl.appendChild(dayCol);
    }

    gridEl.appendChild(bodyEl);

    if (!opt) {
      const emptyBanner = document.createElement('div');
      emptyBanner.className = 'timetable-empty-overlay';
      emptyBanner.textContent = 'Chọn các học phần ở thanh bên trái và nhấn "Tìm thời khóa biểu" để xem kết quả.';
      gridEl.appendChild(emptyBanner);
    }
  }

  // ========================================================================
  // F29 & F30: Detail Modal & Registration Codes Helper Modal
  // ========================================================================

  function openClassDetailModal(sec) {
    const modal = $('classDetailModal');
    const titleEl = $('classDetailModalTitle');
    const bodyEl = $('classDetailModalBody');
    if (!modal || !bodyEl || !sec) return;

    if (titleEl) {
      titleEl.textContent = `${sec.courseName || sec.courseId} (${sec.id})`;
    }

    const lecturerText = sec.lecturer || 'Chưa phân công';
    const sessionsHtml = (sec.sessions || []).map(s => {
      return `
        <div class="detail-session-item">
          <div><strong>${escapeHtml(formatSessionTimeText(s))}</strong></div>
          <div>Phòng: <strong>${escapeHtml(s.room || 'N/A')}</strong> · ${escapeHtml(formatWeeksDisplay(s.weeks))}</div>
        </div>
      `;
    }).join('');

    bodyEl.innerHTML = `
      <div class="detail-grid">
        <div class="detail-label">Mã lớp / Nhóm:</div>
        <div><strong>${escapeHtml(sec.id)}</strong></div>
        <div class="detail-label">Mã học phần:</div>
        <div>${escapeHtml(sec.courseId)}</div>
        <div class="detail-label">Tên học phần:</div>
        <div>${escapeHtml(sec.courseName)}</div>
        <div class="detail-label">Loại lớp:</div>
        <div>${escapeHtml(sec.type || 'LT')}</div>
        <div class="detail-label">Giảng viên:</div>
        <div>${escapeHtml(lecturerText)}</div>
        <div class="detail-label">Lớp sinh viên:</div>
        <div>${escapeHtml(sec.cohort || 'N/A')}</div>
        <div class="detail-label">Mã ghép:</div>
        <div>${escapeHtml(sec.groupCode || 'Không có')}</div>
      </div>
      <div class="detail-label" style="margin-bottom:6px;">Lịch học trong tuần:</div>
      <div class="detail-sessions-list">${sessionsHtml}</div>
    `;

    modal.classList.remove('hidden');
  }

  function openRegCodesModal() {
    const modal = $('regCodesModal');
    const bodyEl = $('regCodesModalBody');
    if (!modal || !bodyEl) return;

    const opt = getActiveOption();
    if (!opt || !opt.classes || opt.classes.length === 0) {
      bodyEl.innerHTML = '<div class="empty-state-small">Chưa có phương án thời khóa biểu nào được hiển thị.</div>';
      modal.classList.remove('hidden');
      return;
    }

    const rowsHtml = opt.classes.map((sec, idx) => {
      const course = getCourseById(sec.courseId);
      const credits = course ? course.credits : '';
      return `
        <tr>
          <td>${idx + 1}</td>
          <td>${escapeHtml(sec.courseId)}</td>
          <td>${escapeHtml(sec.courseName)}</td>
          <td><strong>${escapeHtml(sec.id)}</strong></td>
          <td>${escapeHtml(sec.type || '')}</td>
          <td>${escapeHtml(credits)}</td>
        </tr>
      `;
    }).join('');

    const commaCodes = opt.classes.map(c => c.id).join(', ');
    bodyEl.innerHTML = `
      <table class="reg-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Mã HP</th>
            <th>Tên học phần</th>
            <th>Mã lớp / Nhóm</th>
            <th>Loại</th>
            <th>TC</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <label class="detail-label" style="display:block; margin-bottom:4px;">Danh sách mã lớp đăng ký:</label>
      <textarea class="code-textarea" readonly>${escapeHtml(commaCodes)}</textarea>
    `;

    modal.classList.remove('hidden');
  }

  function renderAllOutputs() {
    renderDiagnosticBanner();
    renderRegistrationBar();
    renderPaginationAndExports();
    renderTimetableGrid();
  }

  // ========================================================================
  // Dataset Loading & File Upload (F01, F05, F06)
  // ========================================================================

  function applyDataset(dataset, isCustom) {
    state.dataset = dataset;
    state.isCustomDataset = Boolean(isCustom);
    state.selectedCourses = [];
    state.excludedClasses.clear();
    state.results = [];
    state.diagnostic = null;
    state.currentPage = 1;

    const coursesArr = normalizeCoursesCollection(dataset && dataset.courses);
    const subtitleEl = $('datasetSubtitle');
    const countBadge = $('courseCountBadge');
    const resetBtn = $('resetDefaultDataBtn');
    const errBanner = $('parserErrorBanner');

    if (errBanner) {
      errBanner.classList.add('hidden');
      errBanner.textContent = '';
    }
    if (subtitleEl && dataset && dataset.metadata) {
      subtitleEl.textContent = `${dataset.metadata.semester || 'Thời khóa biểu'} · ${coursesArr.length} học phần`;
    }
    if (countBadge) {
      countBadge.textContent = `${coursesArr.length} HP`;
    }
    if (resetBtn) {
      resetBtn.classList.toggle('hidden', !state.isCustomDataset);
    }

    renderRecentCourses();
    renderSelectedCourses();
    renderCreditCounter();
    renderAllOutputs();
  }

  async function handleExcelFile(file) {
    if (!file) return;
    const errBanner = $('parserErrorBanner');
    try {
      if (!root.Parser || typeof root.Parser.parseBuffer !== 'function') {
        throw new Error('Parser chưa sẵn sàng.');
      }
      const buffer = await file.arrayBuffer();
      const parsed = root.Parser.parseBuffer(buffer);
      applyDataset(parsed, true);
      showToast(`Đã tải thành công ${Object.keys(parsed.courses || {}).length} học phần từ "${file.name}".`, 'success');
    } catch (err) {
      const msg = (err && err.message) ? err.message : 'Không thể đọc file Excel. Vui lòng kiểm tra định dạng.';
      if (errBanner) {
        errBanner.textContent = `Lỗi đọc file "${file.name}": ${msg}`;
        errBanner.classList.remove('hidden');
      }
      showToast(msg, 'error');
    }
  }

  // ========================================================================
  // Initialization & Event Wiring
  // ========================================================================

  let initialized = false;

  function bindEvents() {
    // Search autocomplete
    const searchInput = $('courseSearchInput');
    const clearSearchBtn = $('clearSearchBtn');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const q = searchInput.value;
        if (clearSearchBtn) clearSearchBtn.classList.toggle('hidden', !q);
        const matches = searchCourses(state.dataset ? state.dataset.courses : {}, q, 10);
        renderSearchDropdown(matches);
      });

      searchInput.addEventListener('focus', () => {
        if (searchInput.value.trim()) {
          const matches = searchCourses(state.dataset ? state.dataset.courses : {}, searchInput.value, 10);
          renderSearchDropdown(matches);
        }
      });

      searchInput.addEventListener('keydown', (ev) => {
        const items = state.activeSearchResults || [];
        if (ev.key === 'ArrowDown') {
          if (items.length > 0) {
            ev.preventDefault();
            state.searchHighlightIdx = (state.searchHighlightIdx + 1) % items.length;
            updateDropdownHighlight();
          }
        } else if (ev.key === 'ArrowUp') {
          if (items.length > 0) {
            ev.preventDefault();
            state.searchHighlightIdx = (state.searchHighlightIdx - 1 + items.length) % items.length;
            updateDropdownHighlight();
          }
        } else if (ev.key === 'Enter') {
          if (items.length > 0 && state.searchHighlightIdx >= 0 && items[state.searchHighlightIdx]) {
            ev.preventDefault();
            const chosen = items[state.searchHighlightIdx];
            selectCourse(chosen.id);
            searchInput.value = '';
            if (clearSearchBtn) clearSearchBtn.classList.add('hidden');
            hideSearchDropdown();
          }
        } else if (ev.key === 'Escape') {
          hideSearchDropdown();
        }
      });
    }

    if (clearSearchBtn && searchInput) {
      clearSearchBtn.addEventListener('click', () => {
        searchInput.value = '';
        clearSearchBtn.classList.add('hidden');
        hideSearchDropdown();
        searchInput.focus();
      });
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('click', (ev) => {
        const wrapper = searchInput ? searchInput.closest('.search-wrapper') : null;
        if (wrapper && !wrapper.contains(ev.target)) {
          hideSearchDropdown();
        }
      });
    }

    // Clear all courses
    const clearAllBtn = $('clearAllCoursesBtn');
    if (clearAllBtn) {
      clearAllBtn.addEventListener('click', clearAllCourses);
    }

    // 14-session days-off checkboxes
    if (typeof document !== 'undefined') {
      document.querySelectorAll('.dayoff-cb').forEach(cb => {
        cb.addEventListener('change', () => {
          const key = cb.dataset.session;
          if (!key) return;
          if (cb.checked) state.disabledSessions.add(key);
          else state.disabledSessions.delete(key);
          state.currentPage = 1;
          renderAllOutputs();
        });
      });
    }

    const resetDaysOffBtn = $('resetDaysOffBtn');
    if (resetDaysOffBtn) {
      resetDaysOffBtn.addEventListener('click', () => {
        state.disabledSessions.clear();
        document.querySelectorAll('.dayoff-cb').forEach(cb => { cb.checked = false; });
        state.currentPage = 1;
        renderAllOutputs();
      });
    }

    // Solver options
    const altWeeksCb = $('allowAlternatingWeeksCb');
    if (altWeeksCb) {
      altWeeksCb.addEventListener('change', () => {
        state.allowAlternatingWeeks = altWeeksCb.checked;
        state.currentPage = 1;
        renderAllOutputs();
      });
    }

    const avoidB2BCb = $('avoidBackToBackCb');
    if (avoidB2BCb) {
      avoidB2BCb.addEventListener('change', () => {
        state.avoidBackToBack = avoidB2BCb.checked;
        state.currentPage = 1;
        renderAllOutputs();
      });
    }

    const sortBySelect = $('sortBySelect');
    if (sortBySelect) {
      sortBySelect.addEventListener('change', () => {
        state.sortBy = sortBySelect.value;
        state.currentPage = 1;
        if (state.results.length > 0 && root.Scheduler && typeof root.Scheduler.sortResults === 'function') {
          state.results = root.Scheduler.sortResults(state.results, state.sortBy);
        }
        renderAllOutputs();
      });
    }

    const maxResultsSelect = $('maxResultsSelect');
    if (maxResultsSelect) {
      maxResultsSelect.addEventListener('change', () => {
        state.maxResults = maxResultsSelect.value === 'Infinity' ? Infinity : Number(maxResultsSelect.value);
        state.currentPage = 1;
        renderAllOutputs();
      });
    }

    // Generate & Stop buttons
    const generateBtn = $('generateBtn');
    if (generateBtn) {
      generateBtn.addEventListener('click', () => { runScheduler(); });
    }

    const stopSearchBtn = $('stopSearchBtn');
    if (stopSearchBtn) {
      stopSearchBtn.addEventListener('click', () => {
        if (state.currentAbortController) {
          state.currentAbortController.abort();
        }
      });
    }

    // Pagination controls (F33)
    const prevBtn = $('prevPageBtn');
    const nextBtn = $('nextPageBtn');
    const resetPageBtn = $('resetPageBtn');
    const jumpInput = $('pageJumpInput');

    if (prevBtn) prevBtn.addEventListener('click', () => setPage(state.currentPage - 1));
    if (nextBtn) nextBtn.addEventListener('click', () => setPage(state.currentPage + 1));
    if (resetPageBtn) resetPageBtn.addEventListener('click', () => setPage(1));
    if (jumpInput) {
      jumpInput.addEventListener('change', () => setPage(jumpInput.value));
      jumpInput.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') setPage(jumpInput.value);
      });
    }

    // Zoom slider (F32)
    const zoomSlider = $('zoomSlider');
    const resetZoomBtn = $('resetZoomBtn');
    if (zoomSlider) {
      zoomSlider.addEventListener('input', () => setZoom(zoomSlider.value));
    }
    if (resetZoomBtn) {
      resetZoomBtn.addEventListener('click', () => setZoom(1.0));
    }

    // Customizer (F31)
    const customizerBtn = $('openCustomizerBtn');
    const customizerPanel = $('customizerPanel');
    if (customizerBtn && customizerPanel) {
      customizerBtn.addEventListener('click', () => {
        customizerPanel.classList.toggle('hidden');
      });
    }

    const showRoomCb = $('prefShowRoom');
    const showWeeksCb = $('prefShowWeeks');
    const adaptiveCb = $('prefAdaptiveFont');
    const hideWeekendCb = $('prefHideWeekend');

    if (showRoomCb) showRoomCb.addEventListener('change', () => updateDisplayPrefs({ showRoom: showRoomCb.checked }));
    if (showWeeksCb) showWeeksCb.addEventListener('change', () => updateDisplayPrefs({ showWeeks: showWeeksCb.checked }));
    if (adaptiveCb) adaptiveCb.addEventListener('change', () => updateDisplayPrefs({ adaptiveFont: adaptiveCb.checked }));
    if (hideWeekendCb) hideWeekendCb.addEventListener('change', () => updateDisplayPrefs({ hideWeekend: hideWeekendCb.checked }));

    // Specific Class Modal bulk actions (F13)
    const modalSelectAllBtn = $('modalSelectAllBtn');
    const modalDeselectAllBtn = $('modalDeselectAllBtn');
    if (modalSelectAllBtn) {
      modalSelectAllBtn.addEventListener('click', () => {
        if (state.activeClassModalCourseId) selectAllClassesForCourse(state.activeClassModalCourseId);
      });
    }
    if (modalDeselectAllBtn) {
      modalDeselectAllBtn.addEventListener('click', () => {
        if (state.activeClassModalCourseId) deselectAllClassesForCourse(state.activeClassModalCourseId);
      });
    }

    // Generic modal close handlers
    if (typeof document !== 'undefined') {
      document.querySelectorAll('[data-close-modal]').forEach(btn => {
        btn.addEventListener('click', () => {
          const modalId = btn.getAttribute('data-close-modal');
          const m = $(modalId);
          if (m) m.classList.add('hidden');
        });
      });

      document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (ev) => {
          if (ev.target === overlay && overlay.id !== 'progressModal') {
            overlay.classList.add('hidden');
          }
        });
      });
    }

    // Registration code copy & modal (F30)
    const copyCommaBtn = $('copyCommaBtn');
    const copyNewlineBtn = $('copyNewlineBtn');
    const openRegModalBtn = $('openRegModalBtn');
    const modalCopyCommaBtn = $('modalCopyCommaBtn');
    const modalCopyNewlineBtn = $('modalCopyNewlineBtn');

    async function doCopy(sep) {
      const opt = getActiveOption();
      if (!opt || !root.Exporter) return;
      const text = await root.Exporter.copyRegistrationCodes(opt, sep);
      if (text) showToast('Đã sao chép mã lớp vào clipboard.', 'success');
    }

    if (copyCommaBtn) copyCommaBtn.addEventListener('click', () => doCopy(', '));
    if (copyNewlineBtn) copyNewlineBtn.addEventListener('click', () => doCopy('\n'));
    if (modalCopyCommaBtn) modalCopyCommaBtn.addEventListener('click', () => doCopy(', '));
    if (modalCopyNewlineBtn) modalCopyNewlineBtn.addEventListener('click', () => doCopy('\n'));
    if (openRegModalBtn) openRegModalBtn.addEventListener('click', openRegCodesModal);

    // Export actions (F34, F35)
    const exportPngBtn = $('exportPngBtn');
    const exportExcelBtn = $('exportExcelBtn');
    const exportIcalBtn = $('exportIcalBtn');

    if (exportPngBtn) {
      exportPngBtn.addEventListener('click', async () => {
        const opt = getActiveOption();
        const gridEl = $('timetableGrid');
        if (!opt || !gridEl || !root.Exporter) return;
        try {
          const title = (state.dataset && state.dataset.metadata && state.dataset.metadata.semester)
            ? state.dataset.metadata.semester
            : 'Thời khóa biểu HK Xuân 2026-2027';
          await root.Exporter.exportImage(gridEl, title, { optionId: opt.id });
          showToast('Đã xuất ảnh PNG thành công.', 'success');
        } catch (err) {
          showToast(err.message || 'Lỗi xuất ảnh PNG.', 'error');
        }
      });
    }

    if (exportExcelBtn) {
      exportExcelBtn.addEventListener('click', () => {
        const opt = getActiveOption();
        if (!opt || !root.Exporter) return;
        try {
          const title = (state.dataset && state.dataset.metadata && state.dataset.metadata.semester)
            ? state.dataset.metadata.semester
            : 'Thời khóa biểu cá nhân';
          root.Exporter.exportExcel(opt, title);
          showToast('Đã xuất file Excel (.xlsx) thành công.', 'success');
        } catch (err) {
          showToast(err.message || 'Lỗi xuất Excel.', 'error');
        }
      });
    }

    if (exportIcalBtn) {
      exportIcalBtn.addEventListener('click', () => {
        const opt = getActiveOption();
        if (!opt || !root.Exporter) return;
        try {
          root.Exporter.exportICal(opt);
          showToast('Đã xuất lịch iCal (.ics) thành công.', 'success');
        } catch (err) {
          showToast(err.message || 'Lỗi xuất iCal.', 'error');
        }
      });
    }

    // Excel File Upload & Drag-and-Drop (F05, F06)
    const excelFileInput = $('excelFileInput');
    const dropZone = $('dropZone');
    const resetDefaultBtn = $('resetDefaultDataBtn');

    if (excelFileInput) {
      excelFileInput.addEventListener('change', (ev) => {
        const file = ev.target.files && ev.target.files[0];
        if (file) handleExcelFile(file);
        excelFileInput.value = '';
      });
    }

    if (dropZone) {
      dropZone.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        dropZone.classList.add('drag-over');
      });
      dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
      });
      dropZone.addEventListener('drop', (ev) => {
        ev.preventDefault();
        dropZone.classList.remove('drag-over');
        const file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
        if (file) handleExcelFile(file);
      });
    }

    if (resetDefaultBtn) {
      resetDefaultBtn.addEventListener('click', () => {
        if (root.DEFAULT_DATA) {
          applyDataset(root.DEFAULT_DATA, false);
          showToast('Đã khôi phục dữ liệu học kỳ mặc định.', 'info');
        }
      });
    }
  }

  function init() {
    if (initialized) return;
    initialized = true;

    state.recentCourseIds = loadRecentCoursesFromStorage();
    loadPrefsFromStorage();
    syncCustomizerCheckboxes();

    if (typeof document !== 'undefined' && document.getElementById('timetableGrid')) {
      bindEvents();
      setZoom(1.0);
      if (root.DEFAULT_DATA) {
        applyDataset(root.DEFAULT_DATA, false);
      } else {
        renderAllOutputs();
      }
    }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  const UI = {
    DAY_START_MINUTE: DAY_START_MINUTE,
    DAY_END_MINUTE: DAY_END_MINUTE,
    COURSE_COLORS: COURSE_COLORS,
    escapeHtml: escapeHtml,
    removeVietnameseDiacritics: removeVietnameseDiacritics,
    searchCourses: searchCourses,
    formatCreditCounter: formatCreditCounter,
    calculateSlotPosition: calculateSlotPosition,
    partitionOverlappingSlots: partitionOverlappingSlots,
    getClassColorTheme: getClassColorTheme,
    getCourseColor: getCourseColor,
    formatWeeksDisplay: formatWeeksDisplay,
    formatSessionTimeText: formatSessionTimeText,
    clampZoom: clampZoom,
    getVisibleDays: getVisibleDays,
    addRecentCourse: addRecentCourse,
    getRecentCourses: getRecentCourses,
    selectCourse: selectCourse,
    removeCourse: removeCourse,
    clearAllCourses: clearAllCourses,
    toggleCourseEnabled: toggleCourseEnabled,
    openClassModal: openClassModal,
    selectAllClassesForCourse: selectAllClassesForCourse,
    deselectAllClassesForCourse: deselectAllClassesForCourse,
    toggleSectionExclusion: toggleSectionExclusion,
    runScheduler: runScheduler,
    setPage: setPage,
    setZoom: setZoom,
    updateDisplayPrefs: updateDisplayPrefs,
    applyDataset: applyDataset,
    getState: function () {
      return {
        isCustomDataset: state.isCustomDataset,
        selectedCourses: state.selectedCourses,
        recentCourseIds: state.recentCourseIds.slice(),
        excludedClasses: Array.from(state.excludedClasses),
        disabledSessions: Array.from(state.disabledSessions),
        allowAlternatingWeeks: state.allowAlternatingWeeks,
        avoidBackToBack: state.avoidBackToBack,
        sortBy: state.sortBy,
        maxResults: state.maxResults,
        resultsCount: state.results.length,
        results: state.results,
        diagnostic: state.diagnostic,
        currentPage: state.currentPage,
        zoomFactor: state.zoomFactor,
        displayPrefs: Object.assign({}, state.displayPrefs)
      };
    },
    init: init
  };

  if (typeof window !== 'undefined') {
    window.UI = UI;
    window.TimetableUI = UI;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = UI;
  }
  if (typeof root !== 'undefined' && !root.UI) {
    root.UI = UI;
    root.TimetableUI = UI;
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
