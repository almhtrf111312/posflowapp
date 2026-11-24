// Smart Auto-Backup System
// Activity-based backup with local and cloud storage support
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { uploadCloudBackup } from './cloud-backup';
import { formatDateTime } from './utils';

const BACKUP_CONFIG_KEY = 'posflow_backup_config_v1';
const LAST_ACTIVITY_KEY = 'posflow_last_activity_v1';
const BACKUP_INTERVAL_HOURS = 3; // Backup every 3 hours if active
const IDLE_BACKUP_INTERVAL_HOURS = 24; // Backup once daily if idle

export interface BackupConfig {
  enabled: boolean;
  lastBackupTime?: string;
  lastActivityTime?: string;
  autoCloudBackup: boolean;
  autoLocalStorage: boolean;
  backupOnExit: boolean;
}

// Load backup configuration
export const loadBackupConfig = (): BackupConfig => {
  try {
    const stored = localStorage.getItem(BACKUP_CONFIG_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // ignore
  }
  return {
    enabled: true,
    autoCloudBackup: true,
    autoLocalStorage: true,
    backupOnExit: true,
  };
};

// Save backup configuration
export const saveBackupConfig = (config: BackupConfig): void => {
  try {
    localStorage.setItem(BACKUP_CONFIG_KEY, JSON.stringify(config));
  } catch {
    // ignore
  }
};

// Record activity (call this after any transaction)
export const recordActivity = (): void => {
  try {
    localStorage.setItem(LAST_ACTIVITY_KEY, new Date().toISOString());

    // Update config
    const config = loadBackupConfig();
    config.lastActivityTime = new Date().toISOString();
    saveBackupConfig(config);
  } catch {
    // ignore
  }
};

// Check if backup is needed
export const isBackupNeeded = (): boolean => {
  const config = loadBackupConfig();
  if (!config.enabled) return false;

  const now = new Date();
  const lastBackup = config.lastBackupTime ? new Date(config.lastBackupTime) : null;
  const lastActivity = config.lastActivityTime ? new Date(config.lastActivityTime) : null;

  // If never backed up, backup is needed
  if (!lastBackup) return true;

  const hoursSinceBackup = lastBackup
    ? (now.getTime() - lastBackup.getTime()) / (1000 * 60 * 60)
    : Infinity;

  // If there was activity since last backup
  if (lastActivity && lastBackup && lastActivity > lastBackup) {
    // Backup every 3 hours if active
    return hoursSinceBackup >= BACKUP_INTERVAL_HOURS;
  }

  // If idle, backup once daily
  return hoursSinceBackup >= IDLE_BACKUP_INTERVAL_HOURS;
};

// Get store settings for backup metadata
const getStoreSettings = (): Record<string, unknown> => {
  try {
    const stored = localStorage.getItem('posflow_settings');
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // ignore
  }
  return {};
};

// نسخة كاملة (كل الجداول والأعمدة والصور) — راجع full-backup.ts
export const generateBackupData = async (): Promise<object> => {
  const { buildFullBackup } = await import('./full-backup');
  return buildFullBackup();
};

const tryParse = (key: string) => {
  try {
    const val = localStorage.getItem(key);
    return val ? JSON.parse(val) : null;
  } catch { return null; }
};

// Save backup to local storage (Capacitor Filesystem)
export const saveBackupLocally = async (): Promise<boolean> => {
  try {
    const backupData = await generateBackupData();
    const fileName = `PosFlow - Backup - ${new Date().toISOString().replace(/[:.]/g, '-')}.posflowbak`;

    // Check if running on native platform
    const isNative = typeof window !== 'undefined' &&
      !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();

    if (isNative) {
      await Filesystem.writeFile({
        path: `PosFlow/backups/${fileName}`,
        data: JSON.stringify(backupData, null, 2),
        directory: Directory.Documents,
        encoding: Encoding.UTF8,
        recursive: true,
      });
    } else {
      // على الويب لا نخزن نسخة كاملة (بالصور) في localStorage؛ النسخة السحابية والتنزيل اليدوي كافيان
    }

    return true;
  } catch (error) {
    console.error('Failed to save backup locally:', error);
    return false;
  }
};

// Load local backups list
export const loadLocalBackups = (): Array<{ fileName: string; data: object; createdAt: string }> => {
  try {
    const stored = localStorage.getItem('posflow_local_backups');
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // ignore
  }
  return [];
};

// Save backup to cloud storage
export const saveBackupToCloud = async (): Promise<boolean> => {
  try {
    return await uploadCloudBackup();
  } catch (error) {
    console.error('Failed to save backup to cloud:', error);
    return false;
  }
};

// Perform auto-backup (both local and cloud)
export const performAutoBackup = async (): Promise<{ local: boolean; cloud: boolean }> => {
  const config = loadBackupConfig();
  const results = { local: false, cloud: false };

  if (!config.enabled) {
    return results;
  }

  // Save locally
  if (config.autoLocalStorage) {
    results.local = await saveBackupLocally();
  }

  // Save to cloud storage
  if (config.autoCloudBackup) {
    results.cloud = await saveBackupToCloud();
  }

  // Update last backup time
  if (results.local || results.cloud) {
    config.lastBackupTime = new Date().toISOString();
    saveBackupConfig(config);
  }

  return results;
};

// Once per calendar day on app open: write a local backup file (native only).
// Cloud data is already live, so only the device file is produced here.
const DAILY_BACKUP_DAY_KEY = 'posflow_daily_backup_day';

export const runDailyLocalBackupOnOpen = async (): Promise<boolean> => {
  try {
    const isNative = typeof window !== 'undefined' &&
      !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
    if (!isNative) return false;

    const config = loadBackupConfig();
    if (!config.enabled || !config.autoLocalStorage) return false;

    const today = formatLocalDay(new Date());
    try {
      if (localStorage.getItem(DAILY_BACKUP_DAY_KEY) === today) return false;
    } catch {
      // storage unavailable: still try the backup
    }

    const saved = await saveBackupLocally();
    if (saved) {
      try {
        localStorage.setItem(DAILY_BACKUP_DAY_KEY, today);
      } catch {
        // ignore
      }
    }
    return saved;
  } catch (error) {
    console.error('Daily local backup failed:', error);
    return false;
  }
};

const formatLocalDay = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};


// Generate downloadable JSON backup for manual export
export const generateDownloadableBackup = async (): Promise<{ data: string; fileName: string }> => {
  const backupData = await generateBackupData();
  const fileName = `PosFlow - Backup - ${new Date().toISOString().split('T')[0]}.posflowbak`;

  return {
    data: JSON.stringify(backupData, null, 2),
    fileName,
  };
};

