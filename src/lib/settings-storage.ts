/**
 * Flow POS Pro - Fast Local Settings Storage Engine
 * ==================================================
 * Provides synchronous (0ms) read/write operations for store settings.
 * Adheres to Offline-First architecture and emits update events on write.
 */

import { emitEvent, EVENTS } from '@/lib/events';

export const SETTINGS_STORAGE_KEY = 'hyperpos_settings_v1';

/**
 * Synchronously retrieves stored store settings from local storage.
 * Never throws, never returns null/undefined; returns empty object on failure.
 */
export function getStoredSettingsLocally<T = Record<string, unknown>>(): T {
  if (typeof window === 'undefined') {
    return {} as T;
  }

  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return {} as T;
    }
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed as T : ({} as T);
  } catch (err) {
    console.warn('[settings-storage] Failed to parse local settings:', err);
    return {} as T;
  }
}

/**
 * Synchronously saves settings to local storage, merging with any existing values,
 * and emits the SETTINGS_UPDATED event.
 */
export function saveSettingsLocally(settings: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;

  try {
    const existing = getStoredSettingsLocally();
    const merged = {
      ...existing,
      ...settings,
      updatedAt: Date.now(),
    };

    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(merged));
    emitEvent(EVENTS.SETTINGS_UPDATED, merged);
  } catch (err) {
    console.warn('[settings-storage] Failed to save local settings:', err);
  }
}

/**
 * Get a specific key from local settings with optional fallback.
 */
export function getSettingValue<T = unknown>(key: string, defaultValue?: T): T | undefined {
  const settings = getStoredSettingsLocally<Record<string, unknown>>();
  return (settings[key] as T) ?? defaultValue;
}

/**
 * Set a specific key in local settings and persist immediately.
 */
export function setSettingValue(key: string, value: unknown): void {
  saveSettingsLocally({ [key]: value });
}
