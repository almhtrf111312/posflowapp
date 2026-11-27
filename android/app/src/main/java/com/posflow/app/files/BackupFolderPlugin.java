package com.posflow.app.files;

import android.app.Activity;
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
    private static final String AUTHORITY = "com.android.externalstorage.documents";
    private static final int ACCESS = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;

    private boolean supported(Uri uri) {
        if (!AUTHORITY.equals(uri.getAuthority())) return false;
        String id = DocumentsContract.getTreeDocumentId(uri);
        return id.equals("primary:Documents") || id.equals("primary:Documents/" + FOLDER);
    }

    private DocumentFile grantedRoot() {
        for (UriPermission permission : getContext().getContentResolver().getPersistedUriPermissions()) {
            Uri uri = permission.getUri();
            if (permission.isReadPermission() && permission.isWritePermission()
                    && DocumentsContract.isTreeUri(uri) && supported(uri)) {
                DocumentFile root = DocumentFile.fromTreeUri(getContext(), uri);
                if (root != null && root.isDirectory() && root.canWrite()) return root;
            }
        }
        return null;
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", grantedRoot() != null);
        call.resolve(result);
    }

    @PluginMethod
    public void choose(PluginCall call) {
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
            if (!supported(uri)) {
                call.reject("اختر المستندات (Documents) في التخزين الداخلي أو مجلد PosFlow App داخله.");
                return;
            }
            getContext().getContentResolver().takePersistableUriPermission(uri, ACCESS);
            status(call);
        } catch (Exception e) {
            call.reject("تعذّر الحصول على إذن المجلد.", e);
        }
    }

    private DocumentFile backupDir(boolean create) throws IOException {
        DocumentFile root = grantedRoot();
        if (root == null) throw new IOException("Backup folder access required");
        if (DocumentsContract.getTreeDocumentId(root.getUri()).endsWith("/" + FOLDER)) return root;
        DocumentFile child = root.findFile(FOLDER);
        if (child == null && create) child = root.createDirectory(FOLDER);
        return child;
    }

    @PluginMethod
    public void list(PluginCall call) {
        JSArray files = new JSArray();
        try {
            DocumentFile dir = backupDir(false);
            if (dir != null) for (DocumentFile f : dir.listFiles()) {
                if (!f.isFile()) continue;
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

    @PluginMethod
    public void save(PluginCall call) {
        DocumentFile file = null;
        try {
            String name = call.getString("filename");
            String content = call.getString("content");
            if (name == null || name.contains("/") || !name.endsWith(".posflowbak") || content == null || content.isEmpty())
                throw new IOException("Invalid backup");
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
            call.resolve(new JSObject().put("filename", file.getName()));
        } catch (Exception e) {
            if (file != null) file.delete();
            call.reject("Cannot save backup", e);
        }
    }
}
