package com.posflow.app.files;

import android.media.MediaScannerConnection;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.List;

/**
 * يطلب من أندرويد فهرسة ملف كتبه التطبيق في المجلدات العامة (مثل Documents/PosFlow App).
 * بعض مديري الملفات (مثل مدير ملفات شاومي) يعرض فقط الملفات المفهرسة في MediaStore، فكانت النسخ الاحتياطية
 * موجودة فعلاً لكنها لا تظهر للمستخدم (ملاحظة المالك 2026-11-27).
 * scan({ paths: ["/storage/emulated/0/Documents/PosFlow App/x.posflowbak"] }) -> { scanned: n }
 */
@CapacitorPlugin(name = "PosFlowMediaScan")
public class PosFlowMediaScanPlugin extends Plugin {

    @PluginMethod
    public void scan(PluginCall call) {
        JSArray arr = call.getArray("paths");
        if (arr == null) {
            call.reject("paths is required");
            return;
        }
        try {
            List<String> list = arr.toList();
            String[] paths = list.toArray(new String[0]);
            MediaScannerConnection.scanFile(getContext(), paths, null, null);
            JSObject ret = new JSObject();
            ret.put("scanned", paths.length);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("scan failed: " + e.getMessage());
        }
    }
}
