package com.posflow.app.push;

import android.content.Intent;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.firebase.messaging.FirebaseMessaging;

/** Firebase push token + notification-tap routing for the customer app. */
@CapacitorPlugin(name = "PosFlowPush")
public class PosFlowPushPlugin extends Plugin {
    static final String EXTRA_ROUTE = "posflow_route";

    @Override
    public void load() {
        if (getActivity() != null) emitTap(getActivity().getIntent());
    }

    private void emitTap(Intent intent) {
        String route = intent != null ? intent.getStringExtra(EXTRA_ROUTE) : null;
        if (route != null && !route.isEmpty()) {
            intent.removeExtra(EXTRA_ROUTE);
            JSObject data = new JSObject();
            data.put("route", route);
            notifyListeners("pushTapped", data, true);
        }
    }

    @PluginMethod
    public void getFcmToken(PluginCall call) {
        FirebaseMessaging.getInstance().getToken().addOnCompleteListener(t -> {
            if (t.isSuccessful() && t.getResult() != null) {
                call.resolve(new JSObject().put("token", t.getResult()));
            } else {
                call.reject("fcm_token_failed");
            }
        });
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        emitTap(intent);
    }
}
