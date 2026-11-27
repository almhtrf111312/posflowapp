import React from 'react';
import type { DownloadResult } from '@/lib/file-download';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  CheckCircle2,
  Database,
  Download,
  FileUp,
  Loader2,
  RefreshCw,
  Trash2
} from 'lucide-react';
import { useLanguage } from '@/hooks/language-context';
import { LocalBackupSection } from '@/components/settings/LocalBackupSection';

/** Backup-related settings as the parent screen keeps them. */
export interface BackupSettingsValue {
  autoBackup: boolean;
  interval: string;
  keepDays: string;
}

/** One row of the backup list shown by this section. */
export interface BackupItem {
  id: string;
  date: string;
  size: string;
  type: 'auto' | 'manual';
}

export interface BackupSettingsSectionProps {
  handleBackupNow: () => void;
  isBackingUp: boolean;
  handleImportBackup: (e: React.ChangeEvent<HTMLInputElement>) => void;
  isImporting: boolean;
  lastBackupResult: DownloadResult | null;
  backupSettings: BackupSettingsValue;
  setBackupSettings: React.Dispatch<React.SetStateAction<BackupSettingsValue>>;
  syncSettings: { lastSync?: string };
  handleSync: () => void;
  isSyncing: boolean;
  backups: BackupItem[];
  handleRestoreBackup: (backup: BackupItem) => void;
  handleDeleteBackup: (backup: BackupItem) => void;
  importInputRef: React.RefObject<HTMLInputElement | null>;
  /** Backup files found on the device (native only). */
  deviceBackups?: Array<{ name: string; uri: string; size: number; ctime: number }>;
  onRestoreDeviceBackup?: (b: { name: string; uri: string; size: number; ctime: number }) => void;
}

export function BackupSettingsSection({
  handleBackupNow,
  isBackingUp,
  handleImportBackup,
  isImporting,
  lastBackupResult,
  backupSettings,
  setBackupSettings,
  syncSettings,
  handleSync,
  isSyncing,
  backups,
  handleRestoreBackup,
  handleDeleteBackup,
  importInputRef,
  deviceBackups = [],
  onRestoreDeviceBackup,
}: BackupSettingsSectionProps) {
  const { t } = useLanguage();

  return (
          <div className="space-y-4 overflow-hidden">
            <h2 className="text-base sm:text-lg font-bold text-foreground">
              {t('settings.backupSync')}
            </h2>

            {/* Backup & Import */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Button size="sm" onClick={handleBackupNow} disabled={isBackingUp} className="w-full">
                {isBackingUp ? <Loader2 className="w-4 h-4 animate-spin shrink-0" /> : <Download className="w-4 h-4 shrink-0" />}
                <span>{t('settings.downloadBackup')}</span>
              </Button>
              <div className="w-full">
                <input type="file" accept=".posflowbak,.json,application/json,text/plain,application/octet-stream,*/*" onChange={handleImportBackup} className="hidden" id="import-backup" ref={importInputRef} />
                <label htmlFor="import-backup" className="w-full block">
                  <Button variant="outline" size="sm" className="w-full" asChild disabled={isImporting}>
                    <span className="cursor-pointer">
                      {isImporting ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> : <FileUp className="w-3.5 h-3.5 shrink-0" />}
                      <span className="text-xs">{t('settings.importBackup')}</span>
                    </span>
                  </Button>
                </label>
              </div>
            </div>
            {/* Backups saved on this device: restore directly, no file picker */}
            {onRestoreDeviceBackup && deviceBackups.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-muted-foreground">النسخ المحفوظة على الجهاز (Documents/PosFlow App)</p>
                {deviceBackups.slice(0, 10).map(b => (
                  <div key={b.uri} className="flex items-center justify-between gap-2 rounded-lg border border-border p-2">
                    <div className="min-w-0">
                      <div className="text-xs truncate" dir="ltr">{b.name}</div>
                      <div className="text-[10px] text-muted-foreground" dir="ltr">{(b.size / 1024 / 1024).toFixed(2)} MB{b.ctime ? ` · ${new Date(b.ctime).toLocaleString()}` : ''}</div>
                    </div>
                    <Button variant="outline" size="sm" disabled={isImporting} onClick={() => onRestoreDeviceBackup(b)}>استعادة</Button>
                  </div>
                ))}
              </div>
            )}
            {/* Last backup result */}
            {lastBackupResult?.success && (
              <div className="p-2 bg-muted/50 rounded-lg border border-border text-xs flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-primary shrink-0" />
                <span className="text-muted-foreground truncate">
                  {lastBackupResult.path}/{lastBackupResult.filename}
                </span>
              </div>
            )}

            {/* Auto backup + Sync - compact grid */}
            <div className="grid grid-cols-2 gap-2">
              <div className="flex items-center justify-between p-2.5 bg-muted rounded-lg">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-foreground truncate">{t('settings.autoBackup')}</p>
                </div>
                <Switch
                  checked={backupSettings.autoBackup}
                  onCheckedChange={(checked) => setBackupSettings({ ...backupSettings, autoBackup: checked })}
                />
              </div>
              <div className="flex items-center justify-between p-2.5 bg-muted rounded-lg">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-foreground truncate">{t('settings.lastSync')}</p>
                  <p className="text-[10px] text-muted-foreground truncate">{syncSettings.lastSync}</p>
                </div>
                <Button size="icon" variant="ghost" onClick={handleSync} disabled={isSyncing} aria-label={t('settings.lastSync')} className="shrink-0">
                  {isSyncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                </Button>
              </div>
            </div>

            {/* Settings row */}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground">{t('settings.backupInterval')}</label>
                <select
                  value={backupSettings.interval}
                  onChange={(e) => setBackupSettings({ ...backupSettings, interval: e.target.value })}
                  className="w-full min-h-11 sm:min-h-10 px-3 text-sm rounded-[14px] bg-muted border-0 text-foreground"
                >
                  <option value="daily">{t('settings.daily')}</option>
                  <option value="weekly">{t('settings.weekly')}</option>
                  <option value="monthly">{t('settings.monthly')}</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">{t('settings.keepDays')}</label>
                <Input
                  type="number"
                  value={backupSettings.keepDays}
                  onChange={(e) => setBackupSettings({ ...backupSettings, keepDays: e.target.value })}
                  min="7" max="365"
                  dir="ltr"
                  className="bg-muted border-0 tabular-nums"
                />
              </div>
            </div>

            {/* Local Auto-Backup */}
            <LocalBackupSection />

            {/* Recent Backups - compact */}
            <div className="space-y-1.5">
              <h3 className="text-xs font-semibold text-foreground">{t('settings.recentBackups')}</h3>
              {backups.map((backup) => (
                <div key={backup.id} className="flex flex-col gap-1.5 p-2 bg-muted rounded-lg">
                  <div className="flex items-center gap-2 min-w-0">
                    <Database className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-foreground truncate">{backup.date}</p>
                      <p className="text-[10px] text-muted-foreground">{backup.size} • {backup.type === 'auto' ? t('settings.auto') : t('settings.manual')}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 border-t border-border/50 pt-1.5">
                    <Button variant="ghost" size="sm" className="flex-1 gap-1.5" onClick={() => handleRestoreBackup(backup)}>
                      <RefreshCw className="w-4 h-4" />
                      {t('settings.restoreBtn')}
                    </Button>
                    <Button variant="ghost" size="sm" className="flex-1 gap-1.5 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => handleDeleteBackup(backup)}>
                      <Trash2 className="w-4 h-4" />
                      {t('common.delete')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>

  );
}

export default BackupSettingsSection;
