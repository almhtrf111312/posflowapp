// Utilities for consistent local date handling and range checks

/**
 * Convert a Date object or ISO string to a local `YYYY-MM-DD` string.
 * Uses the local timezone so that the day reflects the user's environment.
 * If already in `YYYY-MM-DD` format, returns directly to prevent ECMAScript UTC midnight shifts.
 */
export function toLocalDateString(date: Date | string): string {
  if (!date) return '';
  if (typeof date === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
    const d = new Date(date);
    if (isNaN(d.getTime())) return '';
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Calendar-based date helper methods preventing DST 86400000ms shifts.
 */
export function getTodayLocal(): string {
  return toLocalDateString(new Date());
}

export function getYesterdayLocal(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return toLocalDateString(d);
}

export function getDaysAgoLocal(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return toLocalDateString(d);
}

export function getMonthStartLocal(): string {
  const now = new Date();
  return toLocalDateString(new Date(now.getFullYear(), now.getMonth(), 1));
}

export function getWeekStartLocal(): string {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - (day === 0 ? 6 : day - 1);
  return toLocalDateString(new Date(now.getFullYear(), now.getMonth(), diff));
}

/**
 * Single source of truth for UI date presets.
 */
export function getDatePresetRange(preset: 'today' | 'yesterday' | 'week' | 'month' | 'last30'): { from: string; to: string } {
  const today = getTodayLocal();
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const y = getYesterdayLocal();
      return { from: y, to: y };
    }
    case 'week':
      return { from: getWeekStartLocal(), to: today };
    case 'month':
      return { from: getMonthStartLocal(), to: today };
    case 'last30':
      return { from: getDaysAgoLocal(30), to: today };
    default:
      return { from: today, to: today };
  }
}

/**
 * Get exact start and end UTC ISO strings for a given local date string.
 * Used for accurate Supabase queries bridging browser local day bounds to UTC.
 */
export function getLocalDayUtcRange(dateStr: string): { startIso: string; endIso: string } {
  const [y, m, d] = dateStr.split('-').map(Number);
  return {
    startIso: new Date(y, m - 1, d, 0, 0, 0, 0).toISOString(),
    endIso: new Date(y, m - 1, d, 23, 59, 59, 999).toISOString(),
  };
}

/**
 * Lexical, timezone-safe check whether a date falls between two local YYYY-MM-DD boundaries (inclusive).
 */
export function isDateInRange(
  dateInput: Date | string,
  from: string,
  to: string
): boolean {
  if (!dateInput || !from || !to) return false;
  const dStr = typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput)
    ? dateInput
    : toLocalDateString(dateInput);
  if (!dStr) return false;
  return dStr >= from && dStr <= to;
}
