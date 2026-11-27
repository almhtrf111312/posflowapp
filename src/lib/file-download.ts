/**
 * Cross-platform file download utility
 * Works on web browsers and Capacitor (Android/iOS)
 * Supports direct download to Downloads folder on Android
 */

import { Capacitor, registerPlugin } from '@capacitor/core';

const backupFolder = registerPlugin<{
  status(): Promise<{ granted: boolean }>;
  choose(): Promise<{ granted: boolean }>;
  save(o: { filename: string; content: string }): Promise<{ filename: string }>;
  list(): Promise<{ files: NativeBackupFile[] }>;
}>('BackupFolder');

export const usesAndroidBackupFolder = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

export const hasBackupFolderAccess = async () => (await backupFolder.status()).granted;

export async function prepareBackupFolder(explanation: string): Promise<boolean> {
  if (!usesAndroidBackupFolder() || (await backupFolder.status()).granted) return true;
  if (!window.confirm(explanation)) return false;
  return (await backupFolder.choose()).granted;
}

export async function saveAndroidBackup(filename: string, content: string): Promise<DownloadResult> {
  const saved = await backupFolder.save({ filename, content });
  return { success: true, path: 'Documents/PosFlow App', filename: saved.filename };
}

interface DownloadOptions {
  filename: string;
  content: string;
  mimeType?: string;
}

export interface DownloadResult {
  success: boolean;
  path?: string;
  filename?: string;
}

/**
 * Check if running on native platform (Android/iOS)
 */
export const isNativePlatform = (): boolean => {
  return Capacitor.isNativePlatform();
};

/**
 * Request storage permissions on Android
 */
const requestStoragePermissions = async (): Promise<boolean> => {
  try {
    // Check current permission status
    const { publicStorage } = await (await import('@capacitor/filesystem')).Filesystem.checkPermissions();

    if (publicStorage === 'granted') {
      return true;
    }

    // Request permissions
    const result = await (await import('@capacitor/filesystem')).Filesystem.requestPermissions();
    return result.publicStorage === 'granted';
  } catch (error) {
    console.log('[FileDownload] Permission check error:', error);
    // On newer Android versions, permissions might not be needed
    return true;
  }
};

/**
 * Download/save a file - works on both web and native
 */
export const downloadFile = async (options: DownloadOptions): Promise<DownloadResult> => {
  const { filename, content, mimeType = 'application/json' } = options;

  try {
    if (isNativePlatform()) {
      return await saveFileNative(filename, content, mimeType);
    } else {
      const success = downloadFileWeb(filename, content, mimeType);
      return { success, path: 'Downloads', filename };
    }
  } catch (error) {
    console.error('Download error:', error);
    return { success: false };
  }
};

/**
 * Save file on native platform - tries Downloads first, then fallbacks
 */
/** Folder under Documents that holds manual backups and exports (owner's name: "PosFlow App"). */
export const NATIVE_BACKUP_DIR = 'PosFlow App';

const saveFileNative = async (
  filename: string,
  content: string,
  mimeType: string
): Promise<DownloadResult> => {
  try {
    await requestStoragePermissions();

    // 1. Try Documents directory first
    try {
      const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
      // recursive: the folder is created again if the user deleted it.
      const result = await Filesystem.writeFile({
        path: `${NATIVE_BACKUP_DIR}/${filename}`,
        data: content,
        directory: Directory.Documents,
        encoding: Encoding.UTF8,
        recursive: true,
      });
      // Do not report success unless the file is really there with content.
      const st = await Filesystem.stat({ path: `${NATIVE_BACKUP_DIR}/${filename}`, directory: Directory.Documents });
      if (!st || !(Number(st.size) > 0)) throw new Error('Backup file missing after write');

      console.log('[FileDownload] Saved to Documents/' + NATIVE_BACKUP_DIR + ':', result.uri);
      void indexDocumentsFiles([`${NATIVE_BACKUP_DIR}/${filename}`]);
      return { success: true, path: `Documents/${NATIVE_BACKUP_DIR}`, filename };
    } catch (documentsError) {
      console.warn('[FileDownload] Documents save failed, trying Downloads:', documentsError);
    }

    // 2. Try Downloads directory
    try {
      const result = await (await import('@capacitor/filesystem')).Filesystem.writeFile({
        path: `Download/${filename}`,
        data: content,
        directory: (await import('@capacitor/filesystem')).Directory.ExternalStorage,
        encoding: (await import('@capacitor/filesystem')).Encoding.UTF8,
        recursive: true,
      });

      console.log('[FileDownload] Saved to Downloads:', result.uri);
      return { success: true, path: 'Download', filename };
    } catch (externalError) {
      console.warn('[FileDownload] ExternalStorage save failed:', externalError);
    }

    // 3. Fallback: Save to Cache and Open Share Dialog
    const cacheResult = await (await import('@capacitor/filesystem')).Filesystem.writeFile({
      path: filename,
      data: content,
      directory: (await import('@capacitor/filesystem')).Directory.Cache,
      encoding: (await import('@capacitor/filesystem')).Encoding.UTF8,
    });

    console.log('[FileDownload] Saved to Cache for sharing:', cacheResult.uri);

    await (await import('@capacitor/share')).Share.share({
      title: filename,
      text: 'نسخة احتياطية من PosFlow',
      url: cacheResult.uri,
      dialogTitle: 'حفظ النسخة الاحتياطية',
    });

    return { success: true, path: 'Cache (مشاركة)', filename };
  } catch (error) {
    console.error('[FileDownload] All save methods failed:', error);
    return { success: false };
  }
};

/**
 * Download file on web browser
 */
const downloadFileWeb = (
  filename: string,
  content: string,
  mimeType: string
): boolean => {
  try {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    return true;
  } catch (error) {
    console.error('Web download error:', error);
    return false;
  }
};

/**
 * Download JSON data as a file
 */
export const downloadJSON = async (
  filename: string,
  data: object
): Promise<DownloadResult> => {
  const content = JSON.stringify(data, null, 2);
  return downloadFile({
    filename,
    content,
    mimeType: 'application/json',
  });
};

/**
 * Download text content as a file
 */
export const downloadText = async (
  filename: string,
  content: string
): Promise<DownloadResult> => {
  return downloadFile({
    filename,
    content,
    mimeType: 'text/plain;charset=utf-8',
  });
};

/**
 * Download CSV content as a file
 */
export const downloadCSV = async (
  filename: string,
  content: string
): Promise<DownloadResult> => {
  const BOM = '\uFEFF';
  return downloadFile({
    filename,
    content: BOM + content,
    mimeType: 'text/csv;charset=utf-8',
  });
};

/**
 * Get the default download directory path for display to user
 */
export const getDownloadPath = (): string => {
  if (isNativePlatform()) {
    return 'مجلد التنزيلات (Downloads)';
  }
  return 'مجلد التنزيلات';
};

/**
 * List backup files from native Documents/PosFlow/ directory
 */
export interface NativeBackupFile {
  name: string;
  uri: string;
  size: number;
  ctime: number; // creation timestamp
}

export const listNativeBackups = async (): Promise<NativeBackupFile[]> => {
  if (!isNativePlatform()) return [];
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const all: NativeBackupFile[] = [];
  if (usesAndroidBackupFolder() && (await backupFolder.status()).granted) {
    const { files } = await backupFolder.list();
    all.push(...files.filter(f => /backup/i.test(f.name) && /\.(posflowbak|json)$/i.test(f.name)));
  }
  // Current folder first, then the old "PosFlow" folder so earlier backups stay restorable.
  for (const dir of [NATIVE_BACKUP_DIR, 'PosFlow']) {
    try {
      const result = await Filesystem.readdir({ path: dir, directory: Directory.Documents });
      result.files
        .filter(f => f.type === 'file' && /\.(posflowbak|json)$/i.test(f.name) && /backup/i.test(f.name))
        .filter(f => dir !== NATIVE_BACKUP_DIR || !all.some(b => b.name === f.name))
        .forEach(f => all.push({ name: f.name, uri: `${dir}/${f.name}`, size: f.size || 0, ctime: f.ctime || f.mtime || 0 }));
    } catch (error) {
      console.log('[FileDownload] Cannot read Documents/' + dir + ':', error);
    }
  }
  void indexDocumentsFiles(all.filter(b => !b.uri.startsWith('content://')).map(b => b.uri));
  return all.sort((a, b) => b.ctime - a.ctime);
};

/** Reads a backup listed by listNativeBackups (its `uri` is the path under Documents) as a File for the normal import. */
export const readNativeBackupFile = async (backup: NativeBackupFile): Promise<File> => {
  const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
  const res = await Filesystem.readFile({ path: backup.uri, directory: backup.uri.startsWith('content://') ? undefined : Directory.Documents, encoding: Encoding.UTF8 });
  const text = typeof res.data === 'string' ? res.data : await (res.data as Blob).text();
  return new File([text], backup.name, { type: 'application/json' });
};

/** Opens the system share sheet for a backup listed by listNativeBackups (save to Drive, WhatsApp, Downloads, another phone…). */
export const shareNativeBackup = async (backup: NativeBackupFile): Promise<boolean> => {
  if (!isNativePlatform()) return false;
  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { uri } = backup.uri.startsWith('content://')
      ? await Filesystem.writeFile({
          path: `backup-share/${backup.name}`, directory: Directory.Cache, recursive: true,
          data: await (await readNativeBackupFile(backup)).text(),
          encoding: (await import('@capacitor/filesystem')).Encoding.UTF8,
        })
      : await Filesystem.getUri({ path: backup.uri, directory: Directory.Documents });
    const { Share } = await import('@capacitor/share');
    await Share.share({ title: backup.name, text: 'نسخة احتياطية من PosFlow', url: uri, dialogTitle: 'مشاركة النسخة الاحتياطية' });
    return true;
  } catch (error) {
    console.error('[FileDownload] share backup failed:', error);
    return false;
  }
};

/**
 * Asks Android to index files written under Documents (MediaStore), so file managers that only show indexed files
 * (e.g. Xiaomi's) display the backups. `relPaths` are relative to Documents. Never throws; no-op on web.
 */
export const indexDocumentsFiles = async (relPaths: string[]): Promise<void> => {
  if (!isNativePlatform() || relPaths.length === 0) return;
  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { registerPlugin } = await import('@capacitor/core');
    const MediaScan = registerPlugin<{ scan(o: { paths: string[] }): Promise<{ scanned: number }> }>('PosFlowMediaScan');
    const abs: string[] = [];
    for (const rel of relPaths) {
      const { uri } = await Filesystem.getUri({ path: rel, directory: Directory.Documents });
      abs.push(decodeURIComponent(uri.replace(/^file:\/\//, '')));
    }
    await MediaScan.scan({ paths: abs });
  } catch (error) {
    console.warn('[FileDownload] media index skipped:', error);
  }
};
