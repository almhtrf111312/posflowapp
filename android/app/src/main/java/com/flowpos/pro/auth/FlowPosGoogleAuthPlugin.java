package com.flowpos.pro.auth;

import android.os.CancellationSignal;

import androidx.core.content.ContextCompat;
import androidx.credentials.ClearCredentialStateRequest;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.ClearCredentialException;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.exceptions.NoCredentialException;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;

/**
 * تسجيل الدخول بجوجل عبر Credential Manager (بدون WebView، لذلك لا يُحظر).
 * قابل للإزالة: احذف هذا الملف + سطر registerPlugin في MainActivity + تبعيات googleid في build.gradle.
 */
@CapacitorPlugin(name = "FlowPosGoogleAuth")
public class FlowPosGoogleAuthPlugin extends Plugin {

    @PluginMethod
    public void signIn(final PluginCall call) {
        String serverClientId = call.getString("serverClientId");
        String nonce = call.getString("nonce");
        if (serverClientId == null || serverClientId.isEmpty()) {
            call.reject("missing serverClientId", "CONFIG");
            return;
        }
        if (getActivity() == null) {
            call.reject("no activity", "NO_ACTIVITY");
            return;
        }
        try {
            GetSignInWithGoogleOption.Builder optBuilder = new GetSignInWithGoogleOption.Builder(serverClientId);
            if (nonce != null && !nonce.isEmpty()) optBuilder.setNonce(nonce);
            GetCredentialRequest request = new GetCredentialRequest.Builder()
                    .addCredentialOption(optBuilder.build())
                    .build();
            CredentialManager manager = CredentialManager.create(getContext());
            manager.getCredentialAsync(
                    getActivity(),
                    request,
                    new CancellationSignal(),
                    ContextCompat.getMainExecutor(getContext()),
                    new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                        @Override
                        public void onResult(GetCredentialResponse result) {
                            handleResult(call, result);
                        }

                        @Override
                        public void onError(GetCredentialException e) {
                            if (e instanceof GetCredentialCancellationException) {
                                call.reject("cancelled", "CANCELLED");
                            } else if (e instanceof NoCredentialException) {
                                call.reject("no google account", "NO_CREDENTIAL");
                            } else {
                                call.reject(String.valueOf(e.getMessage()), "GOOGLE_ERROR");
                            }
                        }
                    });
        } catch (Throwable t) {
            call.reject(String.valueOf(t.getMessage()), "GOOGLE_ERROR");
        }
    }

    private void handleResult(PluginCall call, GetCredentialResponse result) {
        try {
            Credential credential = result.getCredential();
            if (credential instanceof CustomCredential
                    && GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())) {
                GoogleIdTokenCredential google = GoogleIdTokenCredential.createFrom(credential.getData());
                JSObject ret = new JSObject();
                ret.put("idToken", google.getIdToken());
                ret.put("email", google.getId());
                ret.put("displayName", google.getDisplayName());
                call.resolve(ret);
                return;
            }
            call.reject("unexpected credential type", "GOOGLE_ERROR");
        } catch (Throwable t) {
            call.reject(String.valueOf(t.getMessage()), "GOOGLE_ERROR");
        }
    }

    @PluginMethod
    public void signOut(final PluginCall call) {
        try {
            CredentialManager.create(getContext()).clearCredentialStateAsync(
                    new ClearCredentialStateRequest(),
                    new CancellationSignal(),
                    ContextCompat.getMainExecutor(getContext()),
                    new CredentialManagerCallback<Void, ClearCredentialException>() {
                        @Override
                        public void onResult(Void unused) { call.resolve(); }

                        @Override
                        public void onError(ClearCredentialException e) { call.resolve(); }
                    });
        } catch (Throwable t) {
            call.resolve();
        }
    }
}
