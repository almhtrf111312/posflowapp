import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/auth-context';

interface PosFlowPushPlugin {
  getFcmToken(): Promise<{ token: string }>;
  addListener(
    eventName: 'pushTapped',
    listener: (data: { route: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

const Push = registerPlugin<PosFlowPushPlugin>('PosFlowPush');

/**
 * Registers this device's Firebase token for the signed-in user (so the server can push
 * support replies and app announcements) and routes notification taps to the right page.
 */
export function usePushRegistration() {
  const { user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !user?.id) return;
    let cancelled = false;
    void (async () => {
      try {
        const { token } = await Push.getFcmToken();
        if (!cancelled && token) {
          await (supabase as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<unknown> }).rpc('register_push_token', { p_token: token });
        }
      } catch { /* push is best-effort */ }
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let handle: { remove: () => Promise<void> } | null = null;
    let cancelled = false;
    Push.addListener('pushTapped', ({ route }) => {
      if (route && route.startsWith('/')) navigate(route);
    }).then((h) => { if (cancelled) void h.remove(); else handle = h; }).catch(() => {});
    return () => { cancelled = true; if (handle) void handle.remove(); };
  }, [navigate]);
}
