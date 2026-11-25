/**
 * scheduler.js - Constraint Satisfaction Scheduling, Filtering & Diagnosis Engine
 * Provides full feature parity with TKB HUST / UED timetable specifications:
 * - Class pinning & exclusion (composite + raw ID matching for duplicate UED section IDs)
 * - 14-session preferred days-off filtering (T2_SANG..CN_CHIEU + T8_* aliases)
 * - MRV (Minimum Remaining Values) backtracking solver
 * - 32-bit period bitmask conflict detection (periods 1-30)
 * - Atomic multi-session class binding (2+ weekly sessions)
 * - Asynchronous chunked execution via setTimeout with progress & cancellation
 * - Week-aware alternating classes & contiguous break avoidance (with lunch break exception)
 * - 7 sorting criteria with tie-breaking & 1-based re-indexing
 * - 5-point (6-code) Vietnamese conflict diagnosis with MUS isolation
 */
(function(root) {
  'use strict';

  const ALL_DAYS = [2, 3, 4, 5, 6, 7, 8];

  const DAY_LABELS = {
    2: 'Thứ 2',
    3: 'Thứ 3',
    4: 'Thứ 4',
    5: 'Thứ 5',
    6: 'Thứ 6',
    7: 'Thứ 7',
    8: 'Chủ Nhật'
  };

  const SESSION_KEYS = [
    'T2_SANG', 'T2_CHIEU',
    'T3_SANG', 'T3_CHIEU',
    'T4_SANG', 'T4_CHIEU',
    'T5_SANG', 'T5_CHIEU',
    'T6_SANG', 'T6_CHIEU',
    'T7_SANG', 'T7_CHIEU',
    'CN_SANG', 'CN_CHIEU'
  ];

  const SORT_CRITERIA = [
    'Random',
    'Free Mornings',
    'Free Afternoons',
    'Total Free',
    'Free Days',
    'Morning Hours',
    'Afternoon Hours'
  ];

  const DEFAULT_WEEK_MASK_LOW = (1 << 20) - 1; // Weeks 1..20

  /**
   * Normalize any collection (Set, Array, Iterable, null/undefined) to a Set<string>.
   */
  function normalizeToSet(input) {
    if (!input) return new Set();
    if (input instanceof Set) return input;
    if (Array.isArray(input)) return new Set(input);
    if (typeof input[Symbol.iterator] === 'function') return new Set(input);
    return new Set();
  }

  /**
   * Normalize course collection (Array, ES6 Map, or plain Object map) into Array<Course>.
   */
  function normalizeCourses(selectedCourses) {
    if (!selectedCourses) return [];
    if (Array.isArray(selectedCourses)) return selectedCourses;
    if (selectedCourses instanceof Map) return Array.from(selectedCourses.values());
    if (typeof selectedCourses === 'object') return Object.values(selectedCourses);
    return [];
  }

  /**
   * Mulberry32 deterministic PRNG for reproducible Random sorting when seed is provided.
   */
  function mulberry32(seed) {
    let a = Number(seed) >>> 0;
    return function() {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Compute 32-bit period bitmask for 1-indexed startPeriod and periodCount (periods 1..30).
   * Example: startPeriod=1, periodCount=3 => 0b00000111 = 7.
   *          startPeriod=12, periodCount=1 => 1 << 11 = 2048.
   */
  function getPeriodBitmask(startPeriod, periodCount) {
    const start = parseInt(startPeriod, 10);
    const count = parseInt(periodCount, 10);
    if (!Number.isFinite(start) || !Number.isFinite(count) || start < 1 || count < 1 || start + count - 1 > 30) {
      return 0;
    }
    return (((1 << count) - 1) << (start - 1)) >>> 0;
  }

  /**
   * Resolve sessionType ('Sáng' | 'Chiều' | 'Tối') from session object.
   */
  function getSessionType(session) {
    if (session && (session.sessionType === 'Sáng' || session.sessionType === 'Chiều' || session.sessionType === 'Tối')) {
      return session.sessionType;
    }
    const start = parseInt(session && session.startPeriod, 10) || 1;
    if (start <= 6) return 'Sáng';
    if (start <= 12) return 'Chiều';
    return 'Tối';
  }

  /**
   * Return normalized session keys for a ClassSession (handles both CN_* and T8_* for Sunday).
   */
  function getSessionKeys(session) {
    const day = parseInt(session && session.day, 10);
    const sType = getSessionType(session);
    const suffix = sType === 'Sáng' ? 'SANG' : (sType === 'Chiều' ? 'CHIEU' : 'TOI');
    if (day === 8) {
      return ['CN_' + suffix, 'T8_' + suffix];
    }
    return ['T' + day + '_' + suffix];
  }

  /**
   * Format a session key (e.g. "T2_SANG", "CN_CHIEU") into a readable Vietnamese label.
   */
  function formatSessionKeyLabel(key) {
    const parts = String(key).split('_');
    if (parts.length !== 2) return key;
    const dayPart = parts[0];
    const periodPart = parts[1];
    let dayLabel = dayPart;
    if (dayPart === 'CN' || dayPart === 'T8') {
      dayLabel = 'Chủ Nhật';
    } else if (dayPart.startsWith('T')) {
      const dNum = parseInt(dayPart.slice(1), 10);
      dayLabel = DAY_LABELS[dNum] || dayPart;
    }
    const periodLabel = periodPart === 'SANG' ? 'Sáng' : (periodPart === 'CHIEU' ? 'Chiều' : 'Tối');
    return dayLabel + ' (' + periodLabel + ')';
  }

  /**
   * Precompile study week descriptor into a 32-bit mask (weeks 1..30) plus optional Set for >30.
   */
  function compileWeeksDescriptor(weeksArr) {
    if (!Array.isArray(weeksArr) || weeksArr.length === 0) {
      return { weekMaskLow: DEFAULT_WEEK_MASK_LOW, extraWeeks: null };
    }
    let maskLow = 0;
    let extra = null;
    for (let i = 0; i < weeksArr.length; i++) {
      const w = parseInt(weeksArr[i], 10);
      if (!Number.isFinite(w)) continue;
      if (w >= 1 && w <= 30) {
        maskLow |= (1 << (w - 1));
      } else {
        if (!extra) extra = new Set();
        extra.add(w);
      }
    }
    if (maskLow === 0 && !extra) {
      return { weekMaskLow: DEFAULT_WEEK_MASK_LOW, extraWeeks: null };
    }
    return { weekMaskLow: maskLow, extraWeeks: extra };
  }

  /**
   * Fast check whether two compiled week descriptors share at least one study week.
   */
  function weeksIntersect(w1, w2) {
    if ((w1.weekMaskLow & w2.weekMaskLow) !== 0) {
      return true;
    }
    if (w1.extraWeeks && w2.extraWeeks) {
      const smaller = w1.extraWeeks.size <= w2.extraWeeks.size ? w1.extraWeeks : w2.extraWeeks;
      const larger = w1.extraWeeks.size <= w2.extraWeeks.size ? w2.extraWeeks : w1.extraWeeks;
      for (const w of smaller) {
        if (larger.has(w)) return true;
      }
    }
    return false;
  }

  /**
   * Check if two ClassSession objects conflict in day, period bitmask, and (if enabled) study weeks.
   */
  function sessionsOverlap(s1, s2, allowAlternatingWeeks) {
    if (!s1 || !s2) return false;
    if (parseInt(s1.day, 10) !== parseInt(s2.day, 10)) return false;

    const m1 = s1.bitmask !== undefined ? s1.bitmask : getPeriodBitmask(s1.startPeriod, s1.periodCount);
    const m2 = s2.bitmask !== undefined ? s2.bitmask : getPeriodBitmask(s2.startPeriod, s2.periodCount);
    if (m1 !== 0 && m2 !== 0) {
      if ((m1 & m2) === 0) return false;
    } else {
      const start1 = parseInt(s1.startPeriod, 10);
      const count1 = parseInt(s1.periodCount, 10) || 1;
      const start2 = parseInt(s2.startPeriod, 10);
      const count2 = parseInt(s2.periodCount, 10) || 1;
      if (!Number.isFinite(start1) || !Number.isFinite(start2) || start1 < 1 || start2 < 1 || count1 < 1 || count2 < 1) {
        return false;
      }
      const end1 = start1 + count1 - 1;
      const end2 = start2 + count2 - 1;
      if (end1 < start2 || end2 < start1) return false;
    }

    if (!allowAlternatingWeeks) return true;

    const w1 = s1.weekMaskLow !== undefined ? s1 : compileWeeksDescriptor(s1.weeks);
    const w2 = s2.weekMaskLow !== undefined ? s2 : compileWeeksDescriptor(s2.weeks);
    return weeksIntersect(w1, w2);
  }

  /**
   * Check if two ClassSection objects overlap on any pair of sessions.
   */
  function sectionsOverlap(sec1, sec2, allowAlternatingWeeks) {
    const list1 = sec1.sessions || [];
    const list2 = sec2.sessions || [];
    for (let i = 0; i < list1.length; i++) {
      for (let j = 0; j < list2.length; j++) {
        if (sessionsOverlap(list1[i], list2[j], allowAlternatingWeeks)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Check if two sessions are back-to-back with zero break.
   * Period 6 morning (ends 11:45) and Period 7 afternoon (starts 12:30) have a 45-min lunch break
   * and are NEVER considered contiguous.
   */
  function sessionsContiguous(s1, s2, allowAlternatingWeeks) {
    if (!s1 || !s2) return false;
    const d1 = parseInt(s1.day, 10);
    const d2 = parseInt(s2.day, 10);
    if (d1 !== d2) return false;

    const start1 = parseInt(s1.startPeriod, 10);
    const start2 = parseInt(s2.startPeriod, 10);
    const end1 = s1.endPeriod !== undefined ? s1.endPeriod : (start1 + (parseInt(s1.periodCount, 10) || 1) - 1);
    const end2 = s2.endPeriod !== undefined ? s2.endPeriod : (start2 + (parseInt(s2.periodCount, 10) || 1) - 1);

    if ((end1 === 6 && start2 === 7) || (end2 === 6 && start1 === 7)) {
      return false;
    }
    const contiguous = (end1 + 1 === start2) || (end2 + 1 === start1);
    if (!contiguous) return false;
    if (allowAlternatingWeeks) {
      const w1 = s1.weekMaskLow !== undefined ? s1 : compileWeeksDescriptor(s1.weeks);
      const w2 = s2.weekMaskLow !== undefined ? s2 : compileWeeksDescriptor(s2.weeks);
      return weeksIntersect(w1, w2);
    }
    return true;
  }

  /**
   * Check if any pair of sessions between two ClassSection objects is contiguous.
   */
  function sectionsContiguous(sec1, sec2, allowAlternatingWeeks) {
    const list1 = sec1.sessions || [];
    const list2 = sec2.sessions || [];
    for (let i = 0; i < list1.length; i++) {
      for (let j = 0; j < list2.length; j++) {
        if (sessionsContiguous(list1[i], list2[j], allowAlternatingWeeks)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Check whether a section is excluded by user's excludedClasses Set.
   * Supports both composite `${course.id}__${sec.id}` (required for 76 repeated UED section IDs)
   * and raw `sec.id` for backwards compatibility with unit tests.
   */
  function isSectionExcluded(course, sec, excludedSet) {
    if (!excludedSet || excludedSet.size === 0) return false;
    const compositeKey = course.id + '__' + sec.id;
    return excludedSet.has(compositeKey) || excludedSet.has(sec.id);
  }

  /**
   * Check whether any session of a section falls into user's disabledSessions Set.
   */
  function isSectionDisabledBySession(sec, disabledSet) {
    if (!disabledSet || disabledSet.size === 0) return false;
    const sessions = sec.sessions || [];
    for (let i = 0; i < sessions.length; i++) {
      const keys = getSessionKeys(sessions[i]);
      for (let k = 0; k < keys.length; k++) {
        if (disabledSet.has(keys[k])) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Precompile a ClassSection into fast internal representation for the bitmask CSP solver.
   */
  function compileSection(sec) {
    const rawSessions = sec.sessions || [];
    const compiledSessions = new Array(rawSessions.length);
    for (let i = 0; i < rawSessions.length; i++) {
      const s = rawSessions[i];
      const day = parseInt(s.day, 10);
      const startPeriod = parseInt(s.startPeriod, 10);
      const periodCount = parseInt(s.periodCount, 10) || 1;
      const endPeriod = startPeriod + periodCount - 1;
      const bitmask = getPeriodBitmask(startPeriod, periodCount);
      const weekDesc = compileWeeksDescriptor(s.weeks);
      compiledSessions[i] = {
        day: day,
        startPeriod: startPeriod,
        periodCount: periodCount,
        endPeriod: endPeriod,
        bitmask: bitmask,
        weekMaskLow: weekDesc.weekMaskLow,
        extraWeeks: weekDesc.extraWeeks
      };
    }
    return {
      raw: sec,
      sessions: compiledSessions
    };
  }

  /**
   * Check if a compiled section can be placed against current day masks & placed sessions.
   */
  function canPlaceCompiledSection(compiledSec, usedDayMasks, placedByDay, allowAlternatingWeeks, avoidBackToBack) {
    const sessions = compiledSec.sessions;
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      const day = s.day;
      if (day < 2 || day > 8) return false;

      if (s.bitmask === 0) {
        if (!Number.isFinite(s.startPeriod) || !Number.isFinite(s.periodCount) || s.startPeriod < 1 || s.periodCount < 1) {
          return false;
        }
        const placed = placedByDay[day];
        for (let j = 0; j < placed.length; j++) {
          const p = placed[j];
          if (!(s.endPeriod < p.startPeriod || p.endPeriod < s.startPeriod)) {
            if (!allowAlternatingWeeks || weeksIntersect(p, s)) {
              return false;
            }
          }
        }
      } else if ((usedDayMasks[day] & s.bitmask) !== 0) {
        if (!allowAlternatingWeeks) {
          return false;
        }
        const placed = placedByDay[day];
        for (let j = 0; j < placed.length; j++) {
          const p = placed[j];
          if ((p.bitmask & s.bitmask) !== 0 && weeksIntersect(p, s)) {
            return false;
          }
        }
      } else {
        const placed = placedByDay[day];
        for (let j = 0; j < placed.length; j++) {
          const p = placed[j];
          if (p.bitmask === 0 && !(s.endPeriod < p.startPeriod || p.endPeriod < s.startPeriod)) {
            if (!allowAlternatingWeeks || weeksIntersect(p, s)) {
              return false;
            }
          }
        }
      }

      if (avoidBackToBack) {
        const placed = placedByDay[day];
        for (let j = 0; j < placed.length; j++) {
          if (sessionsContiguous(placed[j], s)) {
            if (!allowAlternatingWeeks || weeksIntersect(placed[j], s)) {
              return false;
            }
          }
        }
      }
    }
    return true;
  }

  /**
   * Compute schedule metrics across all 7 days (2..8):
   * freeMornings, freeAfternoons, freeHalfDays, freeFullDays, morningHours, afternoonHours.
   */
  function calculateMetrics(classes) {
    const morningDays = new Set();
    const afternoonDays = new Set();
    let morningHours = 0;
    let afternoonHours = 0;

    const list = classes || [];
    for (let i = 0; i < list.length; i++) {
      const sec = list[i];
      const sessions = (sec && sec.sessions) || [];
      for (let j = 0; j < sessions.length; j++) {
        const s = sessions[j];
        const day = parseInt(s.day, 10);
        const sType = getSessionType(s);
        const pCount = parseInt(s.periodCount, 10) || 0;
        if (sType === 'Sáng') {
          morningDays.add(day);
          morningHours += pCount;
        } else if (sType === 'Chiều') {
          afternoonDays.add(day);
          afternoonHours += pCount;
        }
      }
    }

    const freeMornings = ALL_DAYS.length - morningDays.size;
    const freeAfternoons = ALL_DAYS.length - afternoonDays.size;
    const freeHalfDays = freeMornings + freeAfternoons;
    let freeFullDays = 0;
    for (let i = 0; i < ALL_DAYS.length; i++) {
      const d = ALL_DAYS[i];
      if (!morningDays.has(d) && !afternoonDays.has(d)) {
        freeFullDays++;
      }
    }

    return {
      freeMornings: freeMornings,
      freeAfternoons: freeAfternoons,
      freeHalfDays: freeHalfDays,
      freeFullDays: freeFullDays,
      morningHours: morningHours,
      afternoonHours: afternoonHours
    };
  }

  /**
   * Sort ScheduleOption[] by one of the 7 supported criteria with ascending original id tie-breaking
   * and 1-based re-indexing (1..N).
   */
  function sortResults(results, criteria, randomSeed) {
    if (!Array.isArray(results)) return [];
    const cloned = results.slice();
    if (cloned.length === 0) return cloned;

    const mode = criteria || 'Random';

    if (mode === 'Free Mornings') {
      cloned.sort((a, b) => (b.metrics.freeMornings - a.metrics.freeMornings) || (a.id - b.id));
    } else if (mode === 'Free Afternoons') {
      cloned.sort((a, b) => (b.metrics.freeAfternoons - a.metrics.freeAfternoons) || (a.id - b.id));
    } else if (mode === 'Total Free') {
      cloned.sort((a, b) => (b.metrics.freeHalfDays - a.metrics.freeHalfDays) || (a.id - b.id));
    } else if (mode === 'Free Days') {
      cloned.sort((a, b) => (b.metrics.freeFullDays - a.metrics.freeFullDays) || (a.id - b.id));
    } else if (mode === 'Morning Hours') {
      cloned.sort((a, b) => (a.metrics.morningHours - b.metrics.morningHours) || (a.id - b.id));
    } else if (mode === 'Afternoon Hours') {
      cloned.sort((a, b) => (a.metrics.afternoonHours - b.metrics.afternoonHours) || (a.id - b.id));
    } else {
      // 'Random': Fisher-Yates shuffle
      const rng = (randomSeed !== null && randomSeed !== undefined) ? mulberry32(randomSeed) : Math.random;
      for (let i = cloned.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = cloned[i];
        cloned[i] = cloned[j];
        cloned[j] = tmp;
      }
    }

    for (let idx = 0; idx < cloned.length; idx++) {
      cloned[idx].id = idx + 1;
    }
    return cloned;
  }

  /**
   * Fast bounded feasibility check (stops at 1st solution or iterCap) for MUS isolation in diagnostics.
   */
  function checkFeasibilityBounded(entries, allowAlternatingWeeks, avoidBackToBack, iterCap) {
    const K = entries.length;
    if (K === 0) return { feasible: true, hitCap: false };

    const ordered = entries.slice().sort((a, b) => a.candidates.length - b.candidates.length);
    const choiceIdx = new Int32Array(K);
    const usedDayMasks = new Uint32Array(9);
    const maskSnapshot = new Uint32Array(K * 9);
    const placedByDay = Array.from({ length: 9 }, () => []);
    const assigned = new Array(K);

    let depth = 0;
    let iters = 0;

    while (depth >= 0) {
      if (depth === K) {
        return { feasible: true, hitCap: false };
      }
      if (iters >= iterCap) {
        return { feasible: false, hitCap: true };
      }

      const cands = ordered[depth].candidates;
      const idx = choiceIdx[depth];
      if (idx >= cands.length) {
        choiceIdx[depth] = 0;
        depth--;
        if (depth >= 0) {
          const base = depth * 9;
          for (let d = 2; d <= 8; d++) usedDayMasks[d] = maskSnapshot[base + d];
          const prevSessions = assigned[depth].sessions;
          for (let i = prevSessions.length - 1; i >= 0; i--) {
            placedByDay[prevSessions[i].day].pop();
          }
        }
        continue;
      }

      const sec = cands[idx];
      choiceIdx[depth] = idx + 1;
      iters++;

      if (canPlaceCompiledSection(sec, usedDayMasks, placedByDay, allowAlternatingWeeks, avoidBackToBack)) {
        const base = depth * 9;
        for (let d = 2; d <= 8; d++) maskSnapshot[base + d] = usedDayMasks[d];
        for (let i = 0; i < sec.sessions.length; i++) {
          const s = sec.sessions[i];
          usedDayMasks[s.day] |= s.bitmask;
          placedByDay[s.day].push(s);
        }
        assigned[depth] = sec;
        depth++;
        if (depth < K) choiceIdx[depth] = 0;
      }
    }

    return { feasible: false, hitCap: false };
  }

  /**
   * Extract a 1-pass greedy Minimal Unsatisfiable Subset (MUS) when total courses <= 20.
   */
  function extractMinimalUnsatisfiableSubset(entries, allowAlternatingWeeks, avoidBackToBack) {
    if (entries.length <= 2 || entries.length > 20) {
      return entries;
    }
    let current = entries.slice();
    for (let i = entries.length - 1; i >= 0; i--) {
      if (current.length <= 2) break;
      const candidateToDrop = entries[i];
      const reduced = current.filter(item => item !== candidateToDrop);
      const res = checkFeasibilityBounded(reduced, allowAlternatingWeeks, avoidBackToBack, 50000);
      if (!res.feasible && !res.hitCap) {
        current = reduced;
      }
    }
    return current;
  }

  /**
   * Pre-search filtering and empty-candidate diagnosis (Cases 1-3: UNOPENED_COURSE, ALL_DESELECTED, DAYS_OFF_EXCLUDED).
   */
  function buildCourseCandidates(activeCourses, disabledSet, excludedSet) {
    const courseEntries = [];
    const unopenedCourses = [];
    const allDeselectedCourses = [];
    const daysOffExcludedCourses = [];
    const blockedKeyLabels = new Set();

    for (let i = 0; i < activeCourses.length; i++) {
      const course = activeCourses[i];
      const rawClasses = Array.isArray(course.classes) ? course.classes : [];

      if (rawClasses.length === 0) {
        unopenedCourses.push(course);
        courseEntries.push({ course: course, candidates: [], orderIndex: i });
        continue;
      }

      const nonExcluded = [];
      const validCompiled = [];

      for (let j = 0; j < rawClasses.length; j++) {
        const sec = rawClasses[j];
        if (isSectionExcluded(course, sec, excludedSet)) {
          continue;
        }
        nonExcluded.push(sec);

        if (isSectionDisabledBySession(sec, disabledSet)) {
          continue;
        }
        validCompiled.push(compileSection(sec));
      }

      if (nonExcluded.length === 0) {
        allDeselectedCourses.push(course);
      } else if (validCompiled.length === 0) {
        daysOffExcludedCourses.push(course);
        for (let j = 0; j < nonExcluded.length; j++) {
          const sessions = nonExcluded[j].sessions || [];
          for (let k = 0; k < sessions.length; k++) {
            const keys = getSessionKeys(sessions[k]);
            for (let m = 0; m < keys.length; m++) {
              if (disabledSet.has(keys[m])) {
                blockedKeyLabels.add(formatSessionKeyLabel(keys[m]));
              }
            }
          }
        }
      }

      courseEntries.push({ course: course, candidates: validCompiled, orderIndex: i });
    }

    // Priority order: UNOPENED_COURSE -> ALL_DESELECTED -> DAYS_OFF_EXCLUDED
    if (unopenedCourses.length > 0) {
      const first = unopenedCourses[0];
      const names = unopenedCourses.map(c => `'${c.name}' (${c.id})`).join(', ');
      return {
        courseCandidates: courseEntries,
        preDiagnostic: {
          code: 'UNOPENED_COURSE',
          title: 'Học phần không mở lớp',
          details: unopenedCourses.length === 1
            ? `Học phần '${first.name}' (${first.id}) không có lớp nào được mở trong kỳ này.`
            : `Các học phần ${names} không có lớp nào được mở trong kỳ này.`,
          conflictingCourses: unopenedCourses.map(c => c.id)
        }
      };
    }

    if (allDeselectedCourses.length > 0) {
      const first = allDeselectedCourses[0];
      const names = allDeselectedCourses.map(c => `'${c.name}' (${c.id})`).join(', ');
      return {
        courseCandidates: courseEntries,
        preDiagnostic: {
          code: 'ALL_DESELECTED',
          title: 'Tất cả các lớp đã bị bỏ chọn',
          details: allDeselectedCourses.length === 1
            ? `Bạn đã bỏ chọn toàn bộ ${(first.classes || []).length} lớp của học phần '${first.name}' (${first.id}). Vui lòng chọn lại ít nhất một lớp.`
            : `Bạn đã bỏ chọn toàn bộ các lớp của các học phần ${names}. Vui lòng chọn lại ít nhất một lớp.`,
          conflictingCourses: allDeselectedCourses.map(c => c.id)
        }
      };
    }

    if (daysOffExcludedCourses.length > 0) {
      const first = daysOffExcludedCourses[0];
      const names = daysOffExcludedCourses.map(c => `'${c.name}' (${c.id})`).join(', ');
      const labelsList = Array.from(blockedKeyLabels);
      const filterDesc = labelsList.length > 0 ? ` (${labelsList.join(', ')})` : '';
      return {
        courseCandidates: courseEntries,
        preDiagnostic: {
          code: 'DAYS_OFF_EXCLUDED',
          title: 'Bộ lọc buổi nghỉ đã loại hết lớp',
          details: daysOffExcludedCourses.length === 1
            ? `Bộ lọc buổi nghỉ${filterDesc} đã loại bỏ toàn bộ các lớp còn lại của học phần '${first.name}' (${first.id}).`
            : `Bộ lọc buổi nghỉ${filterDesc} đã loại bỏ toàn bộ các lớp còn lại của các học phần ${names}.`,
          conflictingCourses: daysOffExcludedCourses.map(c => c.id)
        }
      };
    }

    return { courseCandidates: courseEntries, preDiagnostic: null };
  }

  /**
   * Diagnose deep conflicts when 0 solutions are found after backtracking (Cases 4 & 5).
   * Accepts either Array<{ course, candidates }> or Array<[course, candidates]> (test_helpers compatibility).
   */
  function diagnoseConflict(courseCandidates, optionsOrAltWeeks) {
    const opts = (typeof optionsOrAltWeeks === 'boolean')
      ? { allowAlternatingWeeks: optionsOrAltWeeks, avoidBackToBack: false }
      : (optionsOrAltWeeks || {});
    const allowAlternatingWeeks = Boolean(opts.allowAlternatingWeeks);
    const avoidBackToBack = Boolean(opts.avoidBackToBack);

    const normalized = (courseCandidates || []).map((entry, idx) => {
      if (Array.isArray(entry)) {
        const course = entry[0];
        const rawSecs = entry[1] || [];
        return {
          course: course,
          candidates: rawSecs.map(s => (s && s.raw ? s : compileSection(s))),
          orderIndex: idx
        };
      }
      return {
        course: entry.course,
        candidates: (entry.candidates || []).map(s => (s && s.raw ? s : compileSection(s))),
        orderIndex: idx
      };
    });

    const n = normalized.length;

    // Case 4a: Pairwise strict time/week conflict between every section of course i and course j
    for (let i = 0; i < n; i++) {
      const c1 = normalized[i].course;
      const secs1 = normalized[i].candidates;
      for (let j = i + 1; j < n; j++) {
        const c2 = normalized[j].course;
        const secs2 = normalized[j].candidates;

        let pairHasValid = false;
        for (let a = 0; a < secs1.length && !pairHasValid; a++) {
          for (let b = 0; b < secs2.length; b++) {
            if (!sectionsOverlap(secs1[a], secs2[b], allowAlternatingWeeks)) {
              pairHasValid = true;
              break;
            }
          }
        }

        if (!pairHasValid) {
          return {
            code: 'PAIRWISE_CONFLICT',
            title: 'Xung đột lịch học trực tiếp giữa 2 học phần',
            details: `Tất cả ${secs1.length} lớp của học phần '${c1.name}' (${c1.id}) đều trùng lịch với tất cả ${secs2.length} lớp của học phần '${c2.name}' (${c2.id}).`,
            conflictingCourses: [c1.id, c2.id]
          };
        }
      }
    }

    // Case 4b: Pairwise conflict caused specifically by avoidBackToBack constraint
    if (avoidBackToBack) {
      for (let i = 0; i < n; i++) {
        const c1 = normalized[i].course;
        const secs1 = normalized[i].candidates;
        for (let j = i + 1; j < n; j++) {
          const c2 = normalized[j].course;
          const secs2 = normalized[j].candidates;

          let pairHasValidWithB2B = false;
          for (let a = 0; a < secs1.length && !pairHasValidWithB2B; a++) {
            for (let b = 0; b < secs2.length; b++) {
              if (!sectionsOverlap(secs1[a], secs2[b], allowAlternatingWeeks) &&
                  !sectionsContiguous(secs1[a], secs2[b], allowAlternatingWeeks)) {
                pairHasValidWithB2B = true;
                break;
              }
            }
          }

          if (!pairHasValidWithB2B) {
            return {
              code: 'PAIRWISE_CONFLICT',
              title: 'Xung đột lịch học trực tiếp giữa 2 học phần',
              details: `Do bật tùy chọn tránh học liên tiếp không nghỉ, tất cả các lớp của '${c1.name}' (${c1.id}) đều xung đột hoặc học liền kề với tất cả các lớp của '${c2.name}' (${c2.id}).`,
              conflictingCourses: [c1.id, c2.id]
            };
          }
        }
      }
    }

    // Isolate minimal unsatisfiable subset so unrelated courses do not pollute conflict reports
    const mus = extractMinimalUnsatisfiableSubset(normalized, allowAlternatingWeeks, avoidBackToBack);

    // Case 5a: Pinned class bottleneck (>= 2 single-candidate courses inside the MUS)
    const pinnedInCore = mus.filter(item => item.candidates.length === 1);
    if (pinnedInCore.length >= 2) {
      const reportedIds = new Set(pinnedInCore.map(item => item.course.id));
      const blockedOthers = mus.filter(item => !reportedIds.has(item.course.id));

      const pinnedNames = pinnedInCore.map(item => `'${item.course.name}' (${item.course.id})`).join(', ');
      const blockedText = blockedOthers.length > 0
        ? `, làm bế tắc toàn bộ lựa chọn của ${blockedOthers.map(item => `'${item.course.name}' (${item.course.id})`).join(', ')}`
        : '';

      return {
        code: 'PINNED_BOTTLENECK',
        title: 'Xung đột do lớp được ghim/cố định',
        details: `Các lớp cố định/duy nhất của ${pinnedNames} gây bế tắc xếp lịch${blockedText}${avoidBackToBack ? ' (bao gồm điều kiện tránh học liên tiếp)' : ''}.`,
        conflictingCourses: pinnedInCore.map(item => item.course.id)
      };
    }

    // Case 5b: Multi-course clique / cycle conflict
    const musNames = mus.map(item => `'${item.course.name}' (${item.course.id})`).join(', ');
    return {
      code: 'CLIQUE_CONFLICT',
      title: 'Xung đột liên hoàn nhiều học phần',
      details: `Không có phương án nào thỏa mãn đồng thời các học phần ${musNames} do trùng chéo lịch giữa các tổ hợp lớp${avoidBackToBack ? ' (bao gồm điều kiện tránh học liên tiếp)' : ''}.`,
      conflictingCourses: mus.map(item => item.course.id)
    };
  }

  /**
   * Normalize solver options object.
   */
  function normalizeOptions(options) {
    const opts = options || {};
    const disabledRaw = normalizeToSet(opts.disabledSessions);
    const disabledSessions = new Set();
    for (const k of disabledRaw) {
      disabledSessions.add(k);
      if (k === 'T8_SANG') disabledSessions.add('CN_SANG');
      else if (k === 'T8_CHIEU') disabledSessions.add('CN_CHIEU');
      else if (k === 'CN_SANG') disabledSessions.add('T8_SANG');
      else if (k === 'CN_CHIEU') disabledSessions.add('T8_CHIEU');
    }

    const excludedClasses = normalizeToSet(opts.excludedClasses);
    const allowAlternatingWeeks = Boolean(opts.allowAlternatingWeeks);
    const avoidBackToBack = Boolean(opts.avoidBackToBack);

    let maxResults;
    if (opts.maxResults === undefined) {
      maxResults = 1000000;
    } else if (opts.maxResults === null || opts.maxResults === Infinity || opts.maxResults === 'Infinity') {
      maxResults = Infinity;
    } else {
      const parsed = Number(opts.maxResults);
      maxResults = Number.isNaN(parsed) ? 1000000 : Math.max(0, parsed);
    }

    const rawChunk = Number(opts.chunkSize);
    const chunkSize = Number.isFinite(rawChunk) && rawChunk > 0
      ? Math.max(1000, Math.min(100000, Math.floor(rawChunk)))
      : 25000;

    const sortBy = opts.sortBy || 'Random';
    const randomSeed = opts.randomSeed !== undefined ? opts.randomSeed : null;
    const signal = opts.signal || null;

    return {
      disabledSessions,
      excludedClasses,
      allowAlternatingWeeks,
      avoidBackToBack,
      maxResults,
      chunkSize,
      sortBy,
      randomSeed,
      signal
    };
  }

  /**
   * Prepare MRV-ordered search context from selectedCourses and normalized options.
   */
  function prepareSearch(selectedCourses, opts) {
    const courseList = normalizeCourses(selectedCourses);
    const activeCourses = courseList.filter(c => c && c.enabled !== false);

    if (activeCourses.length === 0) {
      return { empty: true, ordered: [], preDiagnostic: null };
    }

    const { courseCandidates, preDiagnostic } = buildCourseCandidates(
      activeCourses,
      opts.disabledSessions,
      opts.excludedClasses
    );

    if (preDiagnostic) {
      return { empty: false, ordered: [], preDiagnostic };
    }

    // MRV Ordering: sort ascending by candidate count (stable via original orderIndex)
    const ordered = courseCandidates.slice().sort(
      (a, b) => (a.candidates.length - b.candidates.length) || (a.orderIndex - b.orderIndex)
    );

    return { empty: false, ordered, preDiagnostic: null };
  }

  /**
   * Initialize iterative backtracking state machine.
   */
  function createSolverState(ordered, opts) {
    const K = ordered.length;
    const choiceIdx = new Int32Array(K);
    const currentAssignment = new Array(K);
    const usedDayMasks = new Uint32Array(9);
    const maskSnapshot = new Uint32Array(K * 9);
    const placedByDay = Array.from({ length: 9 }, () => []);
    const branchSizes = ordered.map(entry => Math.max(1, entry.candidates.length));

    let depth = 0;
    let combinationsCount = 0;
    const results = [];
    let cancelled = false;

    function placeAtDepth(d, sec) {
      const base = d * 9;
      for (let day = 2; day <= 8; day++) {
        maskSnapshot[base + day] = usedDayMasks[day];
      }
      const sessions = sec.sessions;
      for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i];
        usedDayMasks[s.day] |= s.bitmask;
        placedByDay[s.day].push(s);
      }
      currentAssignment[d] = sec;
    }

    function unplaceAtDepth(d) {
      const base = d * 9;
      for (let day = 2; day <= 8; day++) {
        usedDayMasks[day] = maskSnapshot[base + day];
      }
      const prevSec = currentAssignment[d];
      if (prevSec && prevSec.sessions) {
        for (let i = prevSessionsLen(prevSec) - 1; i >= 0; i--) {
          placedByDay[prevSec.sessions[i].day].pop();
        }
      }
    }

    function prevSessionsLen(sec) {
      return sec.sessions.length;
    }

    function computeProgressPct(isComplete) {
      if (isComplete || depth < 0 || results.length >= opts.maxResults) {
        return 100;
      }
      let frac = 0;
      let weight = 1;
      const limit = Math.min(depth, K - 1);
      for (let i = 0; i <= limit; i++) {
        weight /= branchSizes[i];
        const idxUsed = i < depth ? Math.max(0, choiceIdx[i] - 1) : choiceIdx[i];
        frac += idxUsed * weight;
      }
      return Math.min(99.9, Math.round(frac * 1000) / 10);
    }

    function stepChunk(maxIterations) {
      let iter = 0;
      while (depth >= 0 && iter < maxIterations) {
        if (opts.signal && opts.signal.aborted) {
          cancelled = true;
          break;
        }
        if (results.length >= opts.maxResults) {
          depth = -1;
          break;
        }

        if (depth === K) {
          combinationsCount++;
          const classes = new Array(K);
          for (let i = 0; i < K; i++) {
            classes[i] = currentAssignment[i].raw;
          }
          results.push({
            id: results.length + 1,
            classes: classes,
            metrics: calculateMetrics(classes)
          });
          if (results.length >= opts.maxResults) {
            depth = -1;
            break;
          }
          depth--;
          unplaceAtDepth(depth);
          continue;
        }

        const candidates = ordered[depth].candidates;
        const idx = choiceIdx[depth];
        if (idx >= candidates.length) {
          choiceIdx[depth] = 0;
          depth--;
          if (depth >= 0) {
            unplaceAtDepth(depth);
          }
          continue;
        }

        const sec = candidates[idx];
        choiceIdx[depth] = idx + 1;
        iter++;
        combinationsCount++;

        if (canPlaceCompiledSection(sec, usedDayMasks, placedByDay, opts.allowAlternatingWeeks, opts.avoidBackToBack)) {
          placeAtDepth(depth, sec);
          depth++;
          if (depth < K) {
            choiceIdx[depth] = 0;
          }
        }
      }

      const isDone = cancelled || depth < 0 || results.length >= opts.maxResults;
      return { isDone, cancelled };
    }

    function finalize() {
      let diagnostic = null;
      if (results.length === 0 && !cancelled) {
        diagnostic = diagnoseConflict(ordered, {
          allowAlternatingWeeks: opts.allowAlternatingWeeks,
          avoidBackToBack: opts.avoidBackToBack
        });
      }

      const finalResults = results.length > 0
        ? sortResults(results, opts.sortBy, opts.randomSeed)
        : results;

      return {
        totalCombinationsSearched: combinationsCount,
        results: finalResults,
        diagnostic: diagnostic
      };
    }

    return {
      stepChunk,
      finalize,
      getProgressData(isComplete) {
        return {
          searched: combinationsCount,
          found: results.length,
          progress: computeProgressPct(isComplete),
          isComplete: Boolean(isComplete)
        };
      },
      markCancelled() {
        cancelled = true;
      }
    };
  }

  /**
   * Asynchronous chunked schedule generation (Features 14-24).
   * Yields every chunkSize iterations (default 25,000, configurable 1,000..100,000) via setTimeout
   * to keep browser UI responsive, emits progress via onProgress, and supports cancellation.
   *
   * @param {Array|Object|Map} selectedCourses
   * @param {Object} [options]
   * @param {Function} [onProgress] - Receives { searched, found, progress, isComplete }; return false to cancel.
   * @returns {Promise<{ totalCombinationsSearched: number, results: Array, diagnostic: Object|null }>}
   */
  function generate(selectedCourses, options, onProgress) {
    const opts = normalizeOptions(options);
    const prep = prepareSearch(selectedCourses, opts);

    if (prep.empty || prep.preDiagnostic) {
      const earlyResult = {
        totalCombinationsSearched: 0,
        results: [],
        diagnostic: prep.preDiagnostic || null
      };
      if (typeof onProgress === 'function') {
        onProgress({ searched: 0, found: 0, progress: 100, isComplete: true });
      }
      return Promise.resolve(earlyResult);
    }

    if (opts.maxResults === 0) {
      const zeroCapResult = {
        totalCombinationsSearched: 0,
        results: [],
        diagnostic: null
      };
      if (typeof onProgress === 'function') {
        onProgress({ searched: 0, found: 0, progress: 100, isComplete: true });
      }
      return Promise.resolve(zeroCapResult);
    }

    const solver = createSolverState(prep.ordered, opts);

    return new Promise((resolve) => {
      function runChunk() {
        if (opts.signal && opts.signal.aborted) {
          solver.markCancelled();
          if (typeof onProgress === 'function') {
            onProgress(solver.getProgressData(true));
          }
          resolve(solver.finalize());
          return;
        }

        const { isDone } = solver.stepChunk(opts.chunkSize);

        if (isDone) {
          if (typeof onProgress === 'function') {
            onProgress(solver.getProgressData(true));
          }
          resolve(solver.finalize());
          return;
        }

        if (typeof onProgress === 'function') {
          const cont = onProgress(solver.getProgressData(false));
          if (cont === false) {
            solver.markCancelled();
            resolve(solver.finalize());
            return;
          }
        }

        setTimeout(runChunk, 0);
      }

      setTimeout(runChunk, 0);
    });
  }

  /**
   * Synchronous schedule generation helper for unit testing and non-async callers.
   */
  function generateSync(selectedCourses, options) {
    const opts = normalizeOptions(options);
    const prep = prepareSearch(selectedCourses, opts);

    if (prep.empty || prep.preDiagnostic) {
      return {
        totalCombinationsSearched: 0,
        results: [],
        diagnostic: prep.preDiagnostic || null
      };
    }

    if (opts.maxResults === 0) {
      return {
        totalCombinationsSearched: 0,
        results: [],
        diagnostic: null
      };
    }

    const solver = createSolverState(prep.ordered, opts);
    while (true) {
      const { isDone } = solver.stepChunk(opts.chunkSize);
      if (isDone) break;
    }
    return solver.finalize();
  }

  const Scheduler = {
    SESSION_KEYS: SESSION_KEYS,
    SORT_CRITERIA: SORT_CRITERIA,
    getPeriodBitmask: getPeriodBitmask,
    getSessionKeys: getSessionKeys,
    sessionsOverlap: sessionsOverlap,
    sectionsOverlap: sectionsOverlap,
    sessionsContiguous: sessionsContiguous,
    sectionsContiguous: sectionsContiguous,
    calculateMetrics: calculateMetrics,
    sortResults: sortResults,
    diagnoseConflict: diagnoseConflict,
    generate: generate,
    generateSync: generateSync
  };

  if (typeof window !== 'undefined') {
    window.Scheduler = Scheduler;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Scheduler;
  }
  if (typeof root !== 'undefined' && !root.Scheduler) {
    root.Scheduler = Scheduler;
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
