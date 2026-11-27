/**
 * Local Auto-Backup System
 * ========================
 * Automatically saves a backup after every write operation (invoice, product, debt, etc.)
 * Stores last 5 backups in localStorage (web) or Documents folder (native).
 */

import { Capacitor } from '@capacitor/core';

export interface LocalBackup {
  id: string;
  reason: string;
  appName?: string;
  timestamp: string;
  size: number; // bytes
  data: Record<string, unknown>;
}

const BACKUP_STORAGE_KEY = 'posflow_local_backups';
const MAX_BACKUPS = 5;
const BACKUP_EVENT = 'posflow_backup_updated';

// Debounce to prevent rapid consecutive backups
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 3000;

/** Write the backup list to localStorage. Returns false instead of throwing when the quota is exceeded. */
function persistBackups(list: LocalBackup[]): boolean {
  try {
    localStorage.setItem(BACKUP_STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/**
 * Gather all localStorage data for backup
 */
function gatherBackupData(): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('posflow_') && key !== BACKUP_STORAGE_KEY) {
      try {
        const raw = localStorage.getItem(key);
        if (raw) data[key] = JSON.parse(raw);
      } catch {
        data[key] = localStorage.getItem(key);
      }
    }
  }
  return data;
}

/**
 * Save backup to native filesystem (Documents/FlowBOS Pro/backups/)
 */
async function saveToNativeFS(backup: LocalBackup): Promise<void> {
  try {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
    const filename = `FlowBOS Pro - Backup - ${backup.id}.json`;
    const content = JSON.stringify(backup);

    await Filesystem.writeFile({
      path: `FlowBOS Pro/backups/${filename}`,
      data: content,
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
      recursive: true,
    });
    console.log('[AutoBackup] Saved to native FS:', filename);
  } catch (e) {
    console.warn('[AutoBackup] Native FS save failed:', e);
  }
}

/**
 * Trigger an automatic backup with a reason
 */
export function triggerAutoBackup(reason: string): void {
  // Owner decision (2026-11-27): no backup after every invoice/expense/product (it wrote to Documents/FlowBOS Pro).
  // Backups are daily (first app open of the day, auto-backup.ts) or manual, all in Documents/PosFlow App.
  void reason;
  return;
  if (debounceTimer) clearTimeout(debounceTimer);

  debounceTimer = setTimeout(() => {
    try {
      const data = gatherBackupData();
      const jsonStr = JSON.stringify(data);

      const backup: LocalBackup = {
        id: Date.now().toString(36),
        reason,
        appName: 'FlowBOS Pro',
        timestamp: new Date().toISOString(),
        size: new Blob([jsonStr]).size,
        data,
      };

      // Load existing backups
      const existing = loadRecentBackups();
      let updated = [backup, ...existing].slice(0, MAX_BACKUPS);

      // Save metadata + data to localStorage. Full copies can exceed the browser quota: if they do,
      // keep only the newest backup's data and the older entries' metadata, so the newest backup is never lost.
      let toSave = updated;
      if (!persistBackups(toSave)) {
        toSave = updated.map((b, i) => (i === 0 ? b : { ...b, data: {} }));
        if (!persistBackups(toSave)) {
          toSave = toSave.slice(0, 1).map(b => ({ ...b, data: {} }));
          persistBackups(toSave);
        }
        console.warn('[AutoBackup] localStorage is full: older backups keep metadata only');
      }
      updated = toSave;

      // Also save to native filesystem if available
      if (Capacitor.isNativePlatform()) {
        saveToNativeFS(backup);
      }

      // Emit event for UI updates
      window.dispatchEvent(new CustomEvent(BACKUP_EVENT, { detail: updated }));
      console.log('[AutoBackup] ✅', reason);
    } catch (e) {
      console.warn('[AutoBackup] Failed:', e);
    }
  }, DEBOUNCE_MS);
}

/**
 * Load recent backups (metadata only for display, data included)
 */
export function loadRecentBackups(): LocalBackup[] {
  try {
    const raw = localStorage.getItem(BACKUP_STORAGE_KEY);
    if (!raw) return [];
    const backups = JSON.parse(raw);
    return Array.isArray(backups) ? backups : [];
  } catch {
    return [];
  }
}

/**
 * Restore from a specific backup
 */
export function restoreFromBackup(backupId: string): boolean {
  try {
    const backups = loadRecentBackups();
    const backup = backups.find(b => b.id === backupId);
    if (!backup || !backup.data) return false;

    // Restore all keys from backup data
    Object.entries(backup.data).forEach(([key, value]) => {
      try {
        localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
      } catch { /* skip */ }
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Format backup size for display
 */
export function formatBackupSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export const BACKUP_UPDATED_EVENT = BACKUP_EVENT;

