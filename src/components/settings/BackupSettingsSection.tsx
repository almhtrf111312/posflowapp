import React from 'react';
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
import { useLanguage } from '@/hooks/use-language';
import { LocalBackupSection } from '@/components/settings/LocalBackupSection';

export interface BackupSettingsSectionProps {
  handleBackupNow: () => void;
  isBackingUp: boolean;
  handleImportBackup: (e: React.ChangeEvent<HTMLInputElement>) => void;
  isImporting: boolean;
  handleExportData: () => void;
  lastBackupResult: any;
  backupSettings: any;
  setBackupSettings: React.Dispatch<React.SetStateAction<any>>;
  syncSettings: any;
  handleSync: () => void;
  isSyncing: boolean;
  backups: any[];
  handleRestoreBackup: (backup: any) => void;
  handleDeleteBackup: (id: string) => void;
  importInputRef: React.RefObject<HTMLInputElement | null>;
}

export function BackupSettingsSection({
  handleBackupNow,
  isBackingUp,
  handleImportBackup,
  isImporting,
  handleExportData,
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
}: BackupSettingsSectionProps) {
  const { t } = useLanguage();

  return (
          <div className="space-y-4 overflow-hidden">
            <h2 className="text-base sm:text-lg font-bold text-foreground">
              {t('settings.backupSync')}
            </h2>

            {/* Backup & Import */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Button size="sm" onClick={handleBackupNow} disabled={isBackingUp} className="w-full h-9">
                {isBackingUp ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> : <Download className="w-3.5 h-3.5 shrink-0" />}
                <span className="text-xs">{t('settings.downloadBackup')}</span>
              </Button>
              <div className="w-full">
                <input type="file" accept=".json,application/json,text/plain" onChange={handleImportBackup} className="hidden" id="import-backup" ref={importInputRef} />
                <label htmlFor="import-backup" className="w-full block">
                  <Button variant="outline" size="sm" className="w-full h-9" asChild disabled={isImporting}>
                    <span className="cursor-pointer">
                      {isImporting ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> : <FileUp className="w-3.5 h-3.5 shrink-0" />}
                      <span className="text-xs">{t('settings.importBackup')}</span>
                    </span>
                  </Button>
                </label>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={handleExportData} className="w-full h-9">
              <Download className="w-3.5 h-3.5 shrink-0" />
              <span className="text-xs">تصدير بيانات JSON</span>
            </Button>

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
                <Button size="sm" variant="ghost" onClick={handleSync} disabled={isSyncing} className="h-7 w-7 p-0 shrink-0">
                  {isSyncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
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
                  className="w-full h-8 px-2 text-xs rounded-md bg-muted border-0 text-foreground"
                >
                  <option value="daily">{t('settings.daily')}</option>
                  <option value="weekly">{t('settings.weekly')}</option>
                  <option value="monthly">{t('settings.monthly')}</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground">{t('settings.keepDays')}</label>
                <Input
                  type="number"
                  value={backupSettings.keepDays}
                  onChange={(e) => setBackupSettings({ ...backupSettings, keepDays: e.target.value })}
                  min="7" max="365"
                  className="h-8 text-xs bg-muted border-0"
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
                    <Button variant="ghost" size="sm" className="flex-1 h-7 gap-1 text-xs" onClick={() => handleRestoreBackup(backup)}>
                      <RefreshCw className="w-3 h-3" />
                      {t('settings.restoreBtn')}
                    </Button>
                    <Button variant="ghost" size="sm" className="flex-1 h-7 gap-1 text-xs text-destructive" onClick={() => handleDeleteBackup(backup)}>
                      <Trash2 className="w-3 h-3" />
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
