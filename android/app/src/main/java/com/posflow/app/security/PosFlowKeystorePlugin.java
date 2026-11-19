package com.posflow.app.security;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * يغلّف مفتاح التخزين المحلي بمفتاح AES-256-GCM محفوظ داخل Android Keystore.
 * المفتاح لا يغادر الـ Keystore ولا يمكن قراءته من ملفات التطبيق؛ التطبيق يرسل البيانات ويستلم الناتج فقط.
 * wrap({ data: base64 }) -> { data: base64(iv + ciphertext) }
 * unwrap({ data: base64(iv + ciphertext) }) -> { data: base64 }
 */
@CapacitorPlugin(name = "PosFlowKeystore")
public class PosFlowKeystorePlugin extends Plugin {

    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "posflow_local_storage_key_v1";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int IV_LENGTH = 12;
    private static final int TAG_BITS = 128;

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            KeyStore.Entry entry = keyStore.getEntry(KEY_ALIAS, null);
            if (entry instanceof KeyStore.SecretKeyEntry) {
                return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
            }
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return generator.generateKey();
    }

    @PluginMethod
    public void wrap(PluginCall call) {
        String data = call.getString("data");
        if (data == null || data.isEmpty()) {
            call.reject("missing data", "BAD_INPUT");
            return;
        }
        try {
            byte[] plain = Base64.decode(data, Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
            byte[] iv = cipher.getIV();
            byte[] encrypted = cipher.doFinal(plain);
            byte[] out = new byte[iv.length + encrypted.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(encrypted, 0, out, iv.length, encrypted.length);
            JSObject result = new JSObject();
            result.put("data", Base64.encodeToString(out, Base64.NO_WRAP));
            call.resolve(result);
        } catch (Exception e) {
            call.reject("wrap failed: " + e.getMessage(), "KEYSTORE_ERROR", e);
        }
    }

    @PluginMethod
    public void unwrap(PluginCall call) {
        String data = call.getString("data");
        if (data == null || data.isEmpty()) {
            call.reject("missing data", "BAD_INPUT");
            return;
        }
        try {
            byte[] in = Base64.decode(data, Base64.NO_WRAP);
            if (in.length <= IV_LENGTH) {
                call.reject("data too short", "BAD_INPUT");
                return;
            }
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(TAG_BITS, in, 0, IV_LENGTH));
            byte[] plain = cipher.doFinal(in, IV_LENGTH, in.length - IV_LENGTH);
            JSObject result = new JSObject();
            result.put("data", Base64.encodeToString(plain, Base64.NO_WRAP));
            call.resolve(result);
        } catch (Exception e) {
            call.reject("unwrap failed: " + e.getMessage(), "KEYSTORE_ERROR", e);
        }
    }
}
