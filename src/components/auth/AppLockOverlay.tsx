import React, { useState, useEffect, useCallback } from 'react';
import { useAppLock } from '@/hooks/use-app-lock';
import { useAuth } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import {
  Lock,
  ShieldCheck,
  Delete,
  RotateCcw,
  Check,
  LogOut,
  AlertTriangle,
  Loader2,
  Fingerprint,
} from 'lucide-react';
import { Button } from '@/components/ui/button';


export function AppLockOverlay() {
  const {
    isLocked,
    unlockApp,
    unlockWithBiometrics,
    isBiometricAvailable,
    isBiometricEnabled,
    pinLength,
    isLockedOut,
    lockoutRemainingSeconds,
  } = useAppLock();
  const { user, signOut } = useAuth();
  const { isRTL } = useLanguage();

  const [enteredPin, setEnteredPin] = useState<string>('');
  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [isBiometricPrompting, setIsBiometricPrompting] = useState<boolean>(false);
  const [isShaking, setIsShaking] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [exitConfirmStep, setExitConfirmStep] = useState<0 | 1 | 2>(0);
  const [hasAutoPromptedBiometrics, setHasAutoPromptedBiometrics] = useState<boolean>(false);

  // إعادة ضبط المدخلات عند فتح القفل أو تغييره
  useEffect(() => {
    if (!isLocked) {
      setEnteredPin('');
      setErrorMessage(null);
      setIsVerifying(false);
      setIsBiometricPrompting(false);
      setHasAutoPromptedBiometrics(false);
      setExitConfirmStep(0);
    }
  }, [isLocked]);

  // مصيدة زر الرجوع في أندرويد (Hardware Back Button Trap)
  useEffect(() => {
    if (!isLocked) return;

    let cleanup: (() => void) | null = null;

    if (Capacitor.isNativePlatform()) {
      CapApp.addListener('backButton', () => {
        CapApp.exitApp();
      })
        .then((handle) => {
          cleanup = () => handle.remove();
        })
        .catch((err) => {
          console.warn('[AppLockOverlay] Failed to bind native backButton:', err);
        });
    }

    return () => {
      cleanup?.();
    };
  }, [isLocked]);

  // التحقق اللحظي وفك القفل (Instant Verify & Auto-Submit)
  const verifyAndUnlock = useCallback(
    async (pinToVerify: string) => {
      if (isLockedOut || isVerifying) return;
      setIsVerifying(true);
      setErrorMessage(null);

      try {
        const success = await unlockApp(pinToVerify);
        if (success) {
          setEnteredPin('');
          setErrorMessage(null);
        } else {
          setIsShaking(true);
          setErrorMessage(isRTL ? 'كلمة المرور خاطئة' : 'Incorrect PIN');
          setEnteredPin('');
          setTimeout(() => setIsShaking(false), 500);
        }
      } catch (err) {
        console.error('[AppLockOverlay] Verification error:', err);
        setErrorMessage(isRTL ? 'حدث خطأ أثناء التحقق' : 'Verification error');
        setEnteredPin('');
      } finally {
        setIsVerifying(false);
      }
    },
    [isLockedOut, isVerifying, unlockApp, isRTL]
  );

  // إدخال الأرقام مع فحص اكتمال الرمز التلقائي (Auto-Submit on Completion)
  const handleDigitPress = (digit: string) => {
    if (isLockedOut || isVerifying) return;
    if (enteredPin.length >= 8) return;
    setErrorMessage(null);

    const nextPin = enteredPin + digit;
    setEnteredPin(nextPin);

    // 🎯 استدعاء التحقق التلقائي اللحظي فور إكمال الخانات دون الحاجة لزر تأكيد
    if (nextPin.length === pinLength) {
      void verifyAndUnlock(nextPin);
    }
  };

  const handleBackspace = () => {
    if (isLockedOut || isVerifying) return;
    setErrorMessage(null);
    setEnteredPin((prev) => prev.slice(0, -1));
  };

  const handleClear = () => {
    if (isLockedOut || isVerifying) return;
    setErrorMessage(null);
    setEnteredPin('');
  };

  // التحقق الحيوي بالبصمة (Biometric / Fingerprint Prompt)
  const handleBiometricAuth = useCallback(async () => {
    if (isLockedOut || isBiometricPrompting || !isBiometricEnabled || !isBiometricAvailable) return;
    setIsBiometricPrompting(true);
    setErrorMessage(null);
    try {
      const success = await unlockWithBiometrics();
      if (!success) {
        // يبقى خيار الـ PIN متاحاً كبديل دائم
      }
    } catch (err) {
      console.warn('[AppLockOverlay] Biometric prompt error:', err);
    } finally {
      setIsBiometricPrompting(false);
    }
  }, [isLockedOut, isBiometricPrompting, isBiometricEnabled, isBiometricAvailable, unlockWithBiometrics]);

  // الفتح التلقائي بالبصمة فور ظهور شاشة القفل عند الإقلاع أو العودة من الخلفية
  useEffect(() => {
    if (
      isLocked &&
      isBiometricEnabled &&
      isBiometricAvailable &&
      !isLockedOut &&
      !hasAutoPromptedBiometrics
    ) {
      setHasAutoPromptedBiometrics(true);
      const timer = setTimeout(() => {
        void handleBiometricAuth();
      }, 350);
      return () => clearTimeout(timer);
    }
  }, [
    isLocked,
    isBiometricEnabled,
    isBiometricAvailable,
    isLockedOut,
    hasAutoPromptedBiometrics,
    handleBiometricAuth,
  ]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isLockedOut) return;
    if (e.key >= '0' && e.key <= '9') {
      handleDigitPress(e.key);
    } else if (e.key === 'Backspace') {
      handleBackspace();
    } else if (e.key === 'Enter') {
      if (enteredPin.length >= 4) {
        void verifyAndUnlock(enteredPin);
      }
    }
  };

  if (!isLocked || !user) {
    return null;
  }

  return (
    <div
      role="dialog"
      data-state="open"
      aria-modal="true"
      aria-labelledby="app-lock-title"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="fixed inset-0 z-[9999] flex flex-col items-center justify-between p-6 bg-background/95 backdrop-blur-md select-none touch-manipulation animate-in fade-in duration-200"
      style={{ direction: isRTL ? 'rtl' : 'ltr' }}
    >
      <style>{`
        @keyframes lock-shake {
          0%, 100% { transform: translateX(0); }
          20%, 60% { transform: translateX(-8px); }
          40%, 80% { transform: translateX(8px); }
        }
      `}</style>

      {/* رأس الشاشة مع أيقونة الأمان */}
      <div className="flex flex-col items-center mt-6 text-center">
        <div className="relative mb-3 flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 shadow-inner">
          <ShieldCheck className="w-9 h-9 text-primary animate-pulse" />
          <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-emerald-500 border-2 border-background flex items-center justify-center">
            <Lock className="w-3 h-3 text-white stroke-[3]" />
          </div>
        </div>

        <h1 id="app-lock-title" className="text-xl font-bold tracking-tight text-foreground">
          {isRTL ? 'تطبيق نقطة البيع مقفل' : 'POS Terminal Locked'}
        </h1>

        <p className="text-xs text-muted-foreground mt-1 max-w-[260px]">
          {isLockedOut
            ? isRTL
              ? `تم حظر المحاولات مؤقتاً! يرجى الانتظار (${lockoutRemainingSeconds} ثانية)`
              : `Locked out temporarily! Wait (${lockoutRemainingSeconds}s)`
            : isRTL
            ? 'أدخل رمز PIN أو استخدم البصمة لفتح القفل'
            : 'Enter PIN or scan fingerprint to unlock'}
        </p>

        {/* نقاط عرض الرمز المدخل مع حركة الاهتزاز الفورية */}
        <div
          className="flex items-center justify-center gap-3.5 my-5"
          style={
            isShaking
              ? {
                  animation: 'lock-shake 0.4s ease-in-out',
                }
              : undefined
          }
        >
          {Array.from({ length: pinLength }).map((_, idx) => (
            <div
              key={idx}
              className={`w-3.5 h-3.5 rounded-full border transition-all duration-200 ${
                idx < enteredPin.length
                  ? 'bg-primary border-primary scale-110 shadow-sm shadow-primary/40'
                  : 'border-muted-foreground/30 bg-muted/20'
              }`}
            />
          ))}
        </div>

        {/* تنبيه الخطأ أو جاري التحقق */}
        <div className="h-6 flex items-center justify-center">
          {isVerifying ? (
            <p className="text-primary font-medium text-xs flex items-center gap-1.5 animate-pulse">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>{isRTL ? 'جاري التحقق...' : 'Verifying...'}</span>
            </p>
          ) : isBiometricPrompting ? (
            <p className="text-primary font-medium text-xs flex items-center gap-1.5 animate-pulse">
              <Fingerprint className="w-3.5 h-3.5 animate-bounce" />
              <span>{isRTL ? 'يرجى لمس مستشعر البصمة...' : 'Scan fingerprint...'}</span>
            </p>
          ) : errorMessage ? (
            <p className="text-destructive font-bold text-xs flex items-center gap-1.5 animate-in fade-in duration-150">
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>{errorMessage}</span>
            </p>
          ) : null}
        </div>
      </div>

      {/* لوحة الأرقام (Touch Keypad) المصممة للمس فائق السرعة */}
      <div className="w-full max-w-[280px] flex flex-col items-center">
        <div className="grid grid-cols-3 gap-3 w-full">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
            <Button
              key={digit}
              type="button"
              variant="outline"
              disabled={isLockedOut || isVerifying}
              onClick={() => handleDigitPress(digit)}
              className="h-14 rounded-2xl text-2xl font-bold font-mono border-border/80 bg-card hover:bg-muted active:scale-95 transition-all shadow-sm"
            >
              {digit}
            </Button>
          ))}

          {/* الزر الأيسر السفلي: زر البصمة إذا كانت مفعلة، أو زر مسح الكل */}
          {isBiometricEnabled && isBiometricAvailable ? (
            <Button
              type="button"
              variant="outline"
              disabled={isLockedOut || isVerifying || isBiometricPrompting}
              onClick={() => void handleBiometricAuth()}
              className="h-14 rounded-2xl border-primary/40 bg-primary/10 text-primary hover:bg-primary/20 active:scale-95 transition-all shadow-sm flex flex-col items-center justify-center"
              title={isRTL ? 'الفتح بالبصمة' : 'Fingerprint'}
            >
              <Fingerprint className="w-6 h-6 stroke-[2.2]" />
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              disabled={isLockedOut || isVerifying || enteredPin.length === 0}
              onClick={handleClear}
              className="h-14 rounded-2xl text-xs font-medium text-muted-foreground hover:bg-muted/80 active:scale-95 transition-all"
              title={isRTL ? 'مسح الكل' : 'Clear All'}
            >
              <RotateCcw className="w-5 h-5" />
            </Button>
          )}

          {/* الرقم صفر */}
          <Button
            type="button"
            variant="outline"
            disabled={isLockedOut || isVerifying}
            onClick={() => handleDigitPress('0')}
            className="h-14 rounded-2xl text-2xl font-bold font-mono border-border/80 bg-card hover:bg-muted active:scale-95 transition-all shadow-sm"
          >
            0
          </Button>

          {/* زر المسح التراجعي */}
          <Button
            type="button"
            variant="ghost"
            disabled={isLockedOut || isVerifying || enteredPin.length === 0}
            onClick={handleBackspace}
            className="h-14 rounded-2xl text-muted-foreground hover:bg-muted/80 active:scale-95 transition-all"
            title={isRTL ? 'مسح' : 'Backspace'}
          >
            <Delete className="w-5 h-5" />
          </Button>
        </div>

        {/* زر الفتح بالبصمة السريع أسفل اللوحة إذا كانت مفعلة ومرئية */}
        {isBiometricEnabled && isBiometricAvailable && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isLockedOut || isVerifying || isBiometricPrompting}
            onClick={() => void handleBiometricAuth()}
            className="mt-3 text-xs font-semibold text-primary hover:text-primary hover:bg-primary/10 rounded-xl flex items-center gap-1.5 transition-all"
          >
            <Fingerprint className="w-4 h-4" />
            <span>{isRTL ? 'الفتح بمستشعر البصمة' : 'Unlock with Fingerprint'}</span>
          </Button>
        )}
      </div>

      {/* زر الطوارئ لتسجيل الخروج وتبديل الحساب */}
      <div className="mb-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setExitConfirmStep(1)}
          className="text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg flex items-center gap-1.5"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span>{isRTL ? 'نسيت الرمز؟ تسجيل الخروج والتبديل' : 'Forgot PIN? Sign Out & Switch'}</span>
        </Button>
      </div>

      {/* حوار تأكيد الخروج الداخلي (Inline Div Overlay - بدون Portals لضمان الاستجابة اللمسية في WebView) */}
      {exitConfirmStep > 0 && (
        <div className="fixed inset-0 z-[10000] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-card border border-border/60 rounded-2xl max-w-sm w-full p-5 shadow-2xl space-y-4" style={{ direction: isRTL ? 'rtl' : 'ltr' }}>
            <div className="flex items-center gap-2.5 text-amber-500 font-bold text-sm">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <span>
                {exitConfirmStep === 1
                  ? (isRTL ? 'تأكيد تسجيل الخروج (خطوة 1 من 2)' : 'Confirm Sign Out (Step 1 of 2)')
                  : (isRTL ? 'تحذير نهائي وتأكيد جازم' : 'Final Warning')}
              </span>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {exitConfirmStep === 1 
                ? (isRTL
                    ? 'هل نسيت الرمز وتريد تسجيل الخروج؟ ستحتاج إلى البريد الإلكتروني وكلمة المرور الرئيسية لإعادة الدخول.'
                    : 'Forgot PIN? You will need your master password to sign back in.')
                : (isRTL
                    ? 'سيتم مسح الرمز المنسي ونقلك لتسجيل الدخول بكلمة المرور الماستر، ثم مطالبتك بتعيين رمز جديد.'
                    : 'The forgotten PIN will be cleared and you will set a new one after master login.')}
            </p>
            <div className="flex items-center justify-end gap-2 pt-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setExitConfirmStep(0)}
                className="rounded-xl text-xs"
              >
                {isRTL ? 'إلغاء' : 'Cancel'}
              </Button>
              <Button
                type="button"
                size="sm"
                className={exitConfirmStep === 1 ? "bg-amber-600 hover:bg-amber-700 text-white rounded-xl text-xs" : "bg-destructive hover:bg-destructive/90 text-white rounded-xl text-xs font-bold"}
                onClick={async () => {
                  if (exitConfirmStep === 1) {
                    setExitConfirmStep(2);
                  } else {
                    setExitConfirmStep(0);
                    // تعليم الجلسة بأن الدخول القادم يتطلب إعادة تعيين الـ PIN
                    if (user?.id) {
                      localStorage.setItem(`flowpos_pin_reset_required_${user.id}`, 'true');
                    }
                    await signOut();
                  }
                }}
              >
                {exitConfirmStep === 1 ? (isRTL ? 'متابعة' : 'Next') : (isRTL ? 'تأكيد الخروج الآن' : 'Sign Out Now')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
