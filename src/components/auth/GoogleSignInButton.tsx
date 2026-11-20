/**
 * زر تسجيل الدخول بجوجل — مستقل وقابل للإزالة (انظر src/lib/auth/google-sign-in.ts).
 * زر الدخول بالبريد وكلمة المرور لا يتأثر بهذا الملف أبداً.
 */
import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/sonner-bridge';
import { supabase } from '@/integrations/supabase/client';
import { useAuth, type SignInResult } from '@/hooks/use-auth';
import {
  GOOGLE_WEB_RETURN_FLAG,
  checkGoogleAccountAllowed,
  getNativeGoogleIdToken,
  googleErrorMessage,
  isGoogleSignInAvailable,
  isElectron,
  isNativeAndroid,
  getDesktopGoogleIdToken,
  nativeGoogleSignOut,
  startWebGoogleSignIn,
} from '@/lib/auth/google-sign-in';

interface Props {
  disabled?: boolean;
  stayLoggedIn?: boolean;
  /** يُستدعى بعد نجاح الدخول وفحوص الحساب — Login يكمل فحص الجهاز والتوجيه كالمعتاد */
  onSignedIn: (result: SignInResult) => void | Promise<void>;
  /** حساب جوجل جديد أكمل بياناته → مسار التسجيل الجديد (معالج الإعداد) */
  onNewAccount: () => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" className="w-5 h-5" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/>
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/>
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/>
    </svg>
  );
}

export function GoogleSignInButton({ disabled, stayLoggedIn = true, onSignedIn, onNewAccount, onBusyChange }: Props) {
  const { signInWithIdToken } = useAuth();
  const [busy, setBusy] = useState(false);
  const handledReturn = useRef(false);

  const setBusyBoth = (v: boolean) => { setBusy(v); onBusyChange?.(v); };

  // يرفض الحساب إن لم يكن مسموحاً، وإلا يسلّم النتيجة لصفحة الدخول
  const finish = async (result: SignInResult) => {
    if (result.error || !result.data?.user) {
      await onSignedIn(result);
      return;
    }
    const check = await checkGoogleAccountAllowed(result.data.user.id, result.data.user.identities ?? []);
    if (check.reason === 'new_account') {
      // الهاتف يُطلب مرة واحدة في الخطوة الأولى من معالج الإعداد
      await onNewAccount();
      return;
    }
    if (!check.allowed) {
      await supabase.auth.signOut();
      await nativeGoogleSignOut();
      toast.error(googleErrorMessage(check.reason || 'no_account'));
      return;
    }
    await onSignedIn(result);
  };

  // الويب: إكمال الفحوص بعد العودة من صفحة جوجل
  useEffect(() => {
    if (handledReturn.current || isNativeAndroid() || isElectron()) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get(GOOGLE_WEB_RETURN_FLAG) !== '1') return;
    handledReturn.current = true;
    params.delete(GOOGLE_WEB_RETURN_FLAG);
    const qs = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
    (async () => {
      setBusyBoth(true);
      try {
        const { data } = await supabase.auth.getSession();
        if (data.session?.user) {
          await finish({ error: null, data: { user: data.session.user, session: data.session } });
        } else {
          toast.error(googleErrorMessage('GOOGLE_ERROR'));
        }
      } finally {
        setBusyBoth(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!isGoogleSignInAvailable()) return null;

  const handleClick = async () => {
    if (busy) return;
    setBusyBoth(true);
    try {
      if (isNativeAndroid() || isElectron()) {
        const res = isElectron() ? await getDesktopGoogleIdToken() : await getNativeGoogleIdToken();
        if (res.ok === false) {
          const msg = googleErrorMessage(res.code);
          if (msg) toast.error(msg, res.code === 'GOOGLE_ERROR' ? { description: `[${res.code}] ${res.message}`.slice(0, 220) } : undefined);
          if (res.code !== 'CANCELLED') console.warn('[GoogleSignIn]', res.code, res.message);
          return;
        }
        const result = await signInWithIdToken(res.idToken, res.rawNonce, stayLoggedIn);
        await finish(result);
      } else {
        const { error } = await startWebGoogleSignIn();
        if (error) toast.error(googleErrorMessage('GOOGLE_ERROR'));
        // عند النجاح يتم التحويل لصفحة جوجل
      }
    } finally {
      setBusyBoth(false);
    }
  };

  const button = (
    <Button
      type="button"
      variant="outline"
      onClick={handleClick}
      disabled={disabled || busy}
      className="w-full h-12 rounded-2xl font-bold flex items-center justify-center gap-2 bg-background hover:bg-muted/60 cursor-pointer text-sm"
    >
      {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <GoogleIcon />}
      <span>المتابعة باستخدام Google</span>
    </Button>
  );

  return button;
}

export default GoogleSignInButton;
