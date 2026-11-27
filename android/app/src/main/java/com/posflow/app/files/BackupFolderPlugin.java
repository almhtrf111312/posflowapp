package com.posflow.app.files;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.ContentUris;
import android.database.Cursor;
import android.provider.MediaStore;
import java.io.InputStream;
import android.content.Intent;
import android.content.UriPermission;
import android.net.Uri;
import android.os.Build;
import android.provider.DocumentsContract;

import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

@CapacitorPlugin(name = "BackupFolder")
public class BackupFolderPlugin extends Plugin {
    private static final String FOLDER = "PosFlow App";
    private static final String RELATIVE_DIR = "Documents/" + FOLDER + "/";
    private static final String AUTHORITY = "com.android.externalstorage.documents";
    private static final int ACCESS = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;

    private boolean legacyFolder(Uri uri) {
        if (!AUTHORITY.equals(uri.getAuthority())) return false;
        String id = DocumentsContract.getTreeDocumentId(uri);
        return id.equals("primary:Documents") || id.equals("primary:Documents/" + FOLDER);
    }

    private DocumentFile grantedRoot() {
        String selected = getContext().getSharedPreferences("backup_folder", 0).getString("tree", null);
        for (UriPermission permission : getContext().getContentResolver().getPersistedUriPermissions()) {
            Uri uri = permission.getUri();
            if (permission.isReadPermission() && permission.isWritePermission()
                    && DocumentsContract.isTreeUri(uri) && (selected == null ? legacyFolder(uri) : selected.equals(uri.toString()))) {
                DocumentFile root = DocumentFile.fromTreeUri(getContext(), uri);
                if (root != null && root.isDirectory() && root.canWrite()) return root;
            }
        }
        return null;
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", Build.VERSION.SDK_INT >= 29 || grantedRoot() != null);
        call.resolve(result);
    }

    @PluginMethod
    public void choose(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 29) {
            status(call);
            return;
        }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(ACCESS | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        if (Build.VERSION.SDK_INT >= 26) intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI,
                DocumentsContract.buildDocumentUri(AUTHORITY, "primary:Documents"));
        startActivityForResult(call, intent, "selected");
    }

    @ActivityCallback
    private void selected(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.resolve(new JSObject().put("granted", false));
            return;
        }
        try {
            Uri uri = data.getData();
            int flags = data.getFlags() & ACCESS;
            if (!DocumentsContract.isTreeUri(uri) || flags != ACCESS) throw new IOException("Read/write access required");
            getContext().getContentResolver().takePersistableUriPermission(uri, flags);
            getContext().getSharedPreferences("backup_folder", 0).edit().putString("tree", uri.toString()).apply();
            status(call);
        } catch (Exception e) {
            call.reject("تعذّر الحصول على إذن المجلد.", e);
        }
    }

    private DocumentFile backupDir(boolean create) throws IOException {
        DocumentFile root = grantedRoot();
        if (root == null) throw new IOException("Backup folder access required");
        if (FOLDER.equals(root.getName())) return root;
        DocumentFile child = root.findFile(FOLDER);
        if (child == null && create) child = root.createDirectory(FOLDER);
        return child;
    }

    @PluginMethod
    public void list(PluginCall call) {
        JSArray files = new JSArray();
        try {
            if (Build.VERSION.SDK_INT >= 29) listMedia(files);
            // Keep files saved in previously authorised folders available after updating.
            DocumentFile dir = grantedRoot() == null ? null : backupDir(false);
            if (dir != null) for (DocumentFile f : dir.listFiles()) {
                if (!f.isFile()) continue;
                if (Build.VERSION.SDK_INT >= 29 && AUTHORITY.equals(f.getUri().getAuthority())
                        && DocumentsContract.getDocumentId(f.getUri()).equals("primary:" + RELATIVE_DIR + f.getName())
                        && containsName(files, f.getName())) continue;
                JSObject entry = new JSObject();
                entry.put("name", f.getName());
                entry.put("uri", f.getUri().toString());
                entry.put("size", f.length());
                entry.put("ctime", f.lastModified());
                files.put(entry);
            }
            call.resolve(new JSObject().put("files", files));
        } catch (Exception e) {
            call.reject("Cannot list backups", e);
        }
    }

    private boolean containsName(JSArray files, String name) {
        for (int i = 0; i < files.length(); i++) {
            if (name.equals(files.optJSONObject(i).optString("name"))) return true;
        }
        return false;
    }

    private Uri collection() {
        return MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
    }

    private void listMedia(JSArray files) throws IOException {
        Uri collection = collection();
        String[] columns = {"_id", "_display_name", "_size", "date_modified"};
        try (Cursor c = getContext().getContentResolver().query(collection, columns,
                "relative_path = ? AND is_pending = 0", new String[]{RELATIVE_DIR}, "date_modified DESC")) {
            if (c == null) throw new IOException("Cannot list backup files");
            while (c.moveToNext()) {
                String name = c.getString(1);
                if (name == null || !(name.endsWith(".posflowbak") || name.endsWith(".json"))) continue;
                files.put(new JSObject().put("name", name)
                        .put("uri", ContentUris.withAppendedId(collection, c.getLong(0)).toString())
                        .put("size", c.getLong(2)).put("ctime", c.getLong(3) * 1000L));
            }
        }
    }

    private void saveMedia(PluginCall call, String name, byte[] bytes) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, RELATIVE_DIR);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = resolver.insert(collection(), values);
        if (uri == null) throw new IOException("Cannot create backup");
        boolean complete = false;
        try {
            try (OutputStream stream = resolver.openOutputStream(uri, "w")) {
                if (stream == null) throw new IOException("Cannot open backup");
                stream.write(bytes);
            }
            values.clear();
            values.put(MediaStore.MediaColumns.IS_PENDING, 0);
            if (resolver.update(uri, values, null, null) != 1) throw new IOException("Cannot publish backup");
            String[] fields = {"_display_name", "relative_path", "is_pending"};
            try (Cursor c = resolver.query(uri, fields, null, null, null)) {
                if (c == null || !c.moveToFirst() || c.getString(0) == null
                        || !c.getString(0).endsWith(".posflowbak") || !RELATIVE_DIR.equals(c.getString(1))
                        || c.getInt(2) != 0) throw new IOException("Invalid published backup");
                verifyContent(resolver, uri, bytes);
                complete = true;
                call.resolve(new JSObject().put("filename", c.getString(0)).put("path", "Documents/" + FOLDER));
            }
        } finally {
            if (!complete) resolver.delete(uri, null, null);
        }
    }

    private void verifyContent(ContentResolver resolver, Uri uri, byte[] bytes) throws IOException {
        try (InputStream in = resolver.openInputStream(uri)) {
            if (in == null) throw new IOException("Cannot reopen backup");
            byte[] buffer = new byte[16384];
            int offset = 0;
            int count;
            while ((count = in.read(buffer)) != -1) {
                if (count > bytes.length - offset) throw new IOException("Unexpected backup length");
                for (int i = 0; i < count; i++)
                    if (buffer[i] != bytes[offset + i]) throw new IOException("Backup content mismatch");
                offset += count;
            }
            if (offset != bytes.length) throw new IOException("Incomplete backup");
        }
    }

    @PluginMethod
    public void save(PluginCall call) {
        DocumentFile file = null;
        try {
            String name = call.getString("filename");
            String content = call.getString("content");
            if (name == null || name.contains("/") || !name.endsWith(".posflowbak") || content == null || content.isEmpty())
                throw new IOException("Invalid backup");
            if (Build.VERSION.SDK_INT >= 29) {
                saveMedia(call, name, content.getBytes(StandardCharsets.UTF_8));
                return;
            }
            DocumentFile dir = backupDir(true);
            if (dir == null) throw new IOException("Cannot create backup folder");
            file = dir.createFile("application/octet-stream", name);
            if (file == null) throw new IOException("Cannot create backup file");
            byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
            try (OutputStream stream = getContext().getContentResolver().openOutputStream(file.getUri(), "w")) {
                if (stream == null) throw new IOException("Cannot open backup");
                stream.write(bytes);
            }
            if (file.length() != bytes.length) throw new IOException("Incomplete backup");
            DocumentFile parent = dir.getParentFile();
            String path = parent == null ? dir.getName() : parent.getName() + "/" + dir.getName();
            if (AUTHORITY.equals(dir.getUri().getAuthority())) {
                String id = DocumentsContract.getDocumentId(dir.getUri());
                if (id.startsWith("primary:")) path = id.substring("primary:".length());
            }
            call.resolve(new JSObject().put("filename", file.getName()).put("path", path));
        } catch (Exception e) {
            if (file != null) file.delete();
            call.reject("Cannot save backup", e);
        }
    }
}
