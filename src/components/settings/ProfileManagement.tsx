import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { useUserRole } from '@/hooks/use-user-role';
import { useLanguage } from '@/hooks/use-language';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription, DialogBody } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useAppLock, setUserPinSecurely } from '@/hooks/use-app-lock';
import { toast } from '@/lib/sonner-bridge';
import { isGuestDemoMode } from '@/lib/demo-data';
import { normalizePhoneNumber } from '@/lib/phone-utils';
import { 
  User, 
  Mail, 
  Lock, 
  Edit, 
  Save, 
  X, 
  Crown,
  Shield,
  Eye,
  EyeOff,
  Loader2,
  Phone,
  KeyRound,
  ShieldCheck,
  Fingerprint
} from 'lucide-react';

export function ProfileManagement() {
  const { user, profile, refreshProfile } = useAuth();
  const { isBoss, isAdmin } = useUserRole();
  const { t } = useLanguage();
  const { isLockEnabled, lockTimeout, setLockConfig, updatePin, isBiometricAvailable, isBiometricEnabled, toggleBiometrics } = useAppLock();
  
  const [isEditingName, setIsEditingName] = useState(false);
  const [newName, setNewName] = useState('');
  const [isSavingName, setIsSavingName] = useState(false);
  
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: ''
  });
  const [showPasswords, setShowPasswords] = useState({
    current: false,
    new: false,
    confirm: false
  });
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  
  const [isEditingEmail, setIsEditingEmail] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [isSavingEmail, setIsSavingEmail] = useState(false);

  const [isEditingPhone, setIsEditingPhone] = useState(false);
  const [newPhone, setNewPhone] = useState('');
  const [isSavingPhone, setIsSavingPhone] = useState(false);

  const [showPinDialog, setShowPinDialog] = useState(false);
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [isSavingPin, setIsSavingPin] = useState(false);

  useEffect(() => {
    if (profile?.full_name) {
      setNewName(profile.full_name);
    }
    if (profile?.phone) {
      setNewPhone(profile.phone);
    }
  }, [profile]);

  const handleSaveName = async () => {
    if (!newName.trim()) {
      toast.error(t('profile.nameRequired'));
      return;
    }

    if (isGuestDemoMode()) {
      toast.success(t('profile.nameUpdated'));
      setIsEditingName(false);
      return;
    }

    setIsSavingName(true);
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ full_name: newName.trim() })
        .eq('user_id', user?.id);

      if (error) throw error;

      await refreshProfile();
      toast.success(t('profile.nameUpdated'));
      setIsEditingName(false);
    } catch (error) {
      console.error('Error updating name:', error);
      toast.error(t('profile.nameUpdateFailed'));
    } finally {
      setIsSavingName(false);
    }
  };

  const handleSaveEmail = async () => {
    if (isGuestDemoMode()) {
      toast.info(t('profile.demoEmailNotAvailable'));
      setIsEditingEmail(false);
      return;
    }

    if (!newEmail.trim()) {
      toast.error(t('profile.emailRequired'));
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(newEmail)) {
      toast.error(t('profile.invalidEmail'));
      return;
    }

    if (newEmail === user?.email) {
      setIsEditingEmail(false);
      return;
    }

    setIsSavingEmail(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      if (!session?.session?.access_token) {
        toast.error(t('profile.loginAgain'));
        return;
      }

      const response = await supabase.functions.invoke('update-boss-email', {
        body: { newEmail: newEmail.trim() },
        headers: {
          Authorization: `Bearer ${session.session.access_token}`,
        },
      });

      if (response.error) {
        throw new Error(response.error.message || t('profile.emailUpdateFailed'));
      }

      if (response.data?.error) {
        if (response.data.error === 'Email already in use') {
          toast.error(t('profile.emailInUse'));
        } else {
          throw new Error(response.data.error);
        }
        return;
      }

      toast.success(t('profile.emailUpdated'));
      setIsEditingEmail(false);
      await supabase.auth.refreshSession();
    } catch (error: any) {
      console.error('Error updating email:', error);
      toast.error(error.message || t('profile.emailUpdateFailed'));
    } finally {
      setIsSavingEmail(false);
    }
  };

  const handleUpdatePhone = async () => {
    if (isGuestDemoMode()) {
      toast.info(t('profile.demoAccountNotAvailable'));
      setIsEditingPhone(false);
      return;
    }

    const normalized = normalizePhoneNumber(newPhone);

    if (normalized) {
      try {
        const { data: checkResult, error: checkError } = await (supabase.rpc as any)('check_phone_email_availability', {
          _phone: normalized,
          _email: '',
          _exclude_user_id: user?.id,
        });

        if (!checkError && checkResult && !checkResult.available) {
          toast.error(checkResult.error || t('profile.phoneAlreadyRegistered'));
          return;
        }
      } catch (err) {
        console.warn('Phone check error:', err);
      }
    }

    setIsSavingPhone(true);
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ phone: normalized || null })
        .eq('user_id', user?.id);

      if (error) {
        if (error.message?.includes('unique') || (error as any).code === '23505') {
          toast.error(t('profile.phoneInUseCannotUse'));
        } else {
          toast.error(`${t('profile.phoneSaveError')}: ${error.message}`);
        }
        return;
      }

      await refreshProfile();
      toast.success(t('profile.phoneUpdated'));
      setIsEditingPhone(false);
    } catch (error: any) {
      console.error('Error updating phone:', error);
      toast.error(t('profile.phoneSaveError'));
    } finally {
      setIsSavingPhone(false);
    }
  };

  const handleSavePin = async () => {
    if (isGuestDemoMode()) {
      toast.info(t('profile.demoNoPin'));
      setShowPinDialog(false);
      return;
    }

    const cleanPin = newPin.trim();
    if (cleanPin.length < 4 || cleanPin.length > 8) {
      toast.error(t('profile.pinLengthError'));
      return;
    }

    if (cleanPin !== confirmPin.trim()) {
      toast.error(t('profile.pinMismatch'));
      return;
    }

    setIsSavingPin(true);
    try {
      const pinRes = await setUserPinSecurely(user?.id || '', cleanPin);

      if (!pinRes.success) {
        toast.error(`${t('profile.pinSetFailed')}: ${pinRes.error || t('profile.unauthorized')}`);
        return;
      }

      await updatePin(cleanPin);
      await refreshProfile();
      toast.success(t('profile.pinSetSuccess'));
      setShowPinDialog(false);
      setNewPin('');
      setConfirmPin('');
    } catch (err: any) {
      console.error('Error setting PIN:', err);
      toast.error(t('profile.pinSetError'));
    } finally {
      setIsSavingPin(false);
    }
  };

  const handleChangePassword = async () => {
    if (isGuestDemoMode()) {
      toast.info(t('profile.demoNoPassword'));
      setShowPasswordDialog(false);
      return;
    }

    if (!passwordForm.currentPassword) {
      toast.error(t('password.currentRequired'));
      return;
    }
    if (!passwordForm.newPassword) {
      toast.error(t('password.newRequired'));
      return;
    }
    if (passwordForm.newPassword.length < 6) {
      toast.error(t('password.minLength'));
      return;
    }
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      toast.error(t('password.mismatch'));
      return;
    }

    setIsChangingPassword(true);
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: user?.email || '',
        password: passwordForm.currentPassword,
      });

      if (signInError) {
        toast.error(t('password.currentWrong'));
        setIsChangingPassword(false);
        return;
      }

      const { error } = await supabase.auth.updateUser({
        password: passwordForm.newPassword
      });

      if (error) throw error;

      toast.success(t('password.changeSuccess'));
      setShowPasswordDialog(false);
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
    } catch (error) {
      console.error('Error changing password:', error);
      toast.error(t('password.changeFailed'));
    } finally {
      setIsChangingPassword(false);
    }
  };

  const getRoleBadge = () => {
    if (isBoss) {
      return (
        <Badge variant="outline" className="bg-warning/15 text-warning border-warning/30">
          <Crown className="w-3 h-3 me-1" />
          {t('profile.role.boss')}
        </Badge>
      );
    }
    if (isAdmin) {
      return (
        <Badge variant="outline" className="bg-info/15 text-info border-info/30">
          <Shield className="w-3 h-3 me-1" />
          {t('profile.role.admin')}
        </Badge>
      );
    }
    return (
      <Badge variant="secondary">
        <User className="w-3 h-3 me-1" />
        {t('profile.role.cashier')}
      </Badge>
    );
  };

  return (
    <div className="space-y-4 max-w-full overflow-hidden">
      <Card className="border-0 sm:border shadow-none sm:shadow-sm bg-transparent sm:bg-card">
        <CardHeader className="px-0 sm:px-6 pt-0 sm:pt-6">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2 text-lg sm:text-xl">
                <User className="w-5 h-5 text-primary shrink-0" />
                <span>{t('profile.title')}</span>
              </CardTitle>
              <CardDescription className="text-xs sm:text-sm mt-1">{t('profile.description')}</CardDescription>
            </div>
            <div className="shrink-0">
              {getRoleBadge()}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 px-0 sm:px-6 pb-0 sm:pb-6">
          {/* Name */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2 text-xs sm:text-sm font-medium">
              <User className="w-4 h-4 text-muted-foreground shrink-0" />
              <span>{t('profile.name')}</span>
            </Label>
            {isEditingName ? (
              <div className="flex gap-2">
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={t('profile.enterName')}
                  className="flex-1 min-w-0"
                />
                <Button size="icon" onClick={handleSaveName} disabled={isSavingName} aria-label={t('common.save')} className="shrink-0">
                  {isSavingName ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                </Button>
                <Button size="icon" variant="outline" onClick={() => { setIsEditingName(false); setNewName(profile?.full_name || ''); }} aria-label={t('common.cancel')} className="shrink-0">
                  <X className="w-4 h-4" />
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3 p-3 bg-muted/60 rounded-xl min-w-0 border border-border/40">
                <span className="truncate flex-1 font-medium text-foreground text-sm">{profile?.full_name || t('profile.notSet')}</span>
                <Button size="sm" variant="ghost" className="shrink-0 h-8 px-2.5 text-xs" onClick={() => setIsEditingName(true)}>
                  <Edit className="w-3.5 h-3.5" />
                  {t('profile.edit')}
                </Button>
              </div>
            )}
          </div>

          {/* Email */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2 text-xs sm:text-sm font-medium">
              <Mail className="w-4 h-4 text-muted-foreground shrink-0" />
              <span>{t('profile.email')}</span>
              {!isBoss && (
                <Badge variant="outline">{t('profile.readOnly')}</Badge>
              )}
            </Label>
            {isBoss && isEditingEmail ? (
              <div className="flex gap-2">
                <Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder={t('profile.enterNewEmail')} className="flex-1 min-w-0" dir="ltr" />
                <Button size="icon" onClick={handleSaveEmail} disabled={isSavingEmail} aria-label={t('common.save')} className="shrink-0">
                  {isSavingEmail ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                </Button>
                <Button size="icon" variant="outline" onClick={() => { setIsEditingEmail(false); setNewEmail(user?.email || ''); }} aria-label={t('common.cancel')} className="shrink-0">
                  <X className="w-4 h-4" />
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3 p-3 bg-muted/60 rounded-xl min-w-0 border border-border/40 overflow-hidden">
                <span dir="ltr" className="truncate flex-1 font-mono text-xs sm:text-sm text-foreground">{user?.email}</span>
                {isBoss && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0 h-8 px-2.5 text-xs ms-1"
                    onClick={() => {
                      if (isGuestDemoMode()) {
                        toast.info(t('profile.demoEmailNotAvailable'));
                        return;
                      }
                      setNewEmail(user?.email || '');
                      setIsEditingEmail(true);
                    }}
                  >
                    <Edit className="w-3.5 h-3.5" />
                    {t('profile.edit')}
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* Phone */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2 text-xs sm:text-sm font-medium">
              <Phone className="w-4 h-4 text-muted-foreground shrink-0" />
              <span>{t('profile.verifiedPhone')}</span>
            </Label>
            {isEditingPhone ? (
              <div className="flex gap-2">
                <Input
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                  placeholder="09XXXXXXXX / +963... / +90..."
                  className="flex-1 min-w-0 font-mono text-start tabular-nums"
                  dir="ltr"
                />
                <Button size="icon" onClick={handleUpdatePhone} disabled={isSavingPhone} aria-label={t('common.save')} className="shrink-0">
                  {isSavingPhone ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                </Button>
                <Button size="icon" variant="outline" onClick={() => { setIsEditingPhone(false); setNewPhone(profile?.phone || ''); }} aria-label={t('common.cancel')} className="shrink-0">
                  <X className="w-4 h-4" />
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3 p-3 bg-muted/60 rounded-xl min-w-0 border border-border/40 overflow-hidden">
                <span dir="ltr" className="truncate flex-1 font-mono text-xs sm:text-sm text-foreground">
                  {profile?.phone || t('profile.notSet')}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0 h-8 px-2.5 text-xs ms-1"
                  onClick={() => {
                    if (isGuestDemoMode()) {
                      toast.info(t('profile.demoAccountNotAvailable'));
                      return;
                    }
                    setNewPhone(profile?.phone || '');
                    setIsEditingPhone(true);
                  }}
                >
                  <Edit className="w-3.5 h-3.5" />
                  {t('profile.edit')}
                </Button>
              </div>
            )}
          </div>

          <Separator className="my-2" />

          {/* Password */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2 text-xs sm:text-sm font-medium">
              <Lock className="w-4 h-4 text-muted-foreground shrink-0" />
              <span>{t('profile.password')}</span>
            </Label>
            <div className="flex items-center justify-between gap-3 p-3 bg-muted/60 rounded-xl min-w-0 border border-border/40">
              <span className="text-muted-foreground tracking-widest text-sm flex-1">••••••••</span>
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0 h-8 px-2.5 text-xs"
                onClick={() => {
                  if (isGuestDemoMode()) {
                    toast.info(t('profile.demoNoPassword'));
                    return;
                  }
                  setShowPasswordDialog(true);
                }}
              >
                <Lock className="w-3.5 h-3.5" />
                {t('profile.changeBtn')}
              </Button>
            </div>
          </div>
          <Separator className="my-2" />

          {/* Quick Cashier PIN */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2 text-xs sm:text-sm font-medium">
              <KeyRound className="w-4 h-4 text-muted-foreground shrink-0" />
              <span>{t('profile.quickAccessPin')}</span>
            </Label>
            <div className="flex items-center justify-between gap-3 p-3 bg-muted/60 rounded-xl min-w-0 border border-border/40">
              <span className="text-muted-foreground tracking-widest text-sm flex-1 font-mono">
                {profile?.pin_hash ? '••••' : t('profile.pinNotSet')}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0 h-8 px-2.5 text-xs"
                onClick={() => {
                  if (isGuestDemoMode()) {
                    toast.info(t('profile.demoNoPin'));
                    return;
                  }
                  setShowPinDialog(true);
                }}
              >
                <KeyRound className="w-3.5 h-3.5" />
                {profile?.pin_hash ? t('profile.changePin') : t('profile.setPin')}
              </Button>
            </div>
          </div>

          <Separator className="my-2" />

          {/* App Security Lock Toggle */}
          <div className="space-y-3 pt-1">
            <div className="flex items-center justify-between gap-3 p-3 bg-muted/60 rounded-xl min-w-0 border border-border/40">
              <div className="flex flex-col gap-0.5">
                <Label className="flex items-center gap-2 text-xs sm:text-sm font-semibold text-foreground cursor-pointer">
                  <ShieldCheck className="w-4 h-4 text-primary shrink-0" />
                  <span>{t('profile.appLockTitle')}</span>
                </Label>
                <span className="text-[11px] text-muted-foreground">
                  {t('profile.appLockDesc')}
                </span>
              </div>
              <Switch
                checked={isLockEnabled}
                onCheckedChange={async (checked) => {
                  if (checked) {
                    const hasPin = !!localStorage.getItem(`posflow_app_lock_${user?.id}_hash`);
                    if (!hasPin) {
                      toast.info(t('profile.pinRequiredForLock'));
                      setShowPinDialog(true);
                      return;
                    }
                    await setLockConfig({ enabled: true, timeoutSeconds: lockTimeout });
                    toast.success(t('profile.appLockEnabled'));
                  } else {
                    await setLockConfig({ enabled: false, timeoutSeconds: lockTimeout });
                    toast.success(t('profile.appLockDisabled'));
                  }
                }}
              />
            </div>

            {isLockEnabled && (
              <>
                <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 bg-muted/40 rounded-xl border border-border/30 text-xs">
                  <span className="text-muted-foreground font-medium">{t('profile.autoLockTimeout')}</span>
                  <select
                    value={lockTimeout}
                    onChange={(e) => {
                      const sec = parseInt(e.target.value, 10);
                      void setLockConfig({ enabled: true, timeoutSeconds: sec });
                    }}
                    className="bg-background border border-border/60 rounded-lg px-2.5 py-1 text-xs text-foreground font-medium outline-none cursor-pointer"
                  >
                    <option value={0}>{t('profile.lockImmediate')}</option>
                    <option value={60}>{t('profile.lockAfter1Min')}</option>
                    <option value={300}>{t('profile.lockAfter5Min')}</option>
                  </select>
                </div>

                <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 bg-muted/40 rounded-xl border border-border/30 text-xs">
                  <span className="text-muted-foreground font-medium">{t('profile.currentQuickPin')}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setNewPin('');
                      setConfirmPin('');
                      setShowPinDialog(true);
                    }}
                    className="h-7 text-xs px-2.5 rounded-lg"
                  >
                    {t('profile.changePinBtn')}
                  </Button>
                </div>
              </>
            )}

            {isLockEnabled && isBiometricAvailable && (
              <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 bg-muted/40 rounded-xl border border-border/30 text-xs">
                <div className="flex items-center gap-2">
                  <Fingerprint className="w-4 h-4 text-primary" />
                  <span className="text-foreground font-medium">{t('profile.biometricUnlock')}</span>
                </div>
                <Switch
                  checked={isBiometricEnabled}
                  onCheckedChange={async (checked) => {
                    const success = await toggleBiometrics(checked);
                    if (success) {
                      toast.success(
                        checked
                          ? t('profile.biometricEnabled')
                          : t('profile.biometricDisabled')
                      );
                    } else {
                      toast.error(t('profile.biometricFailed'));
                    }
                  }}
                />
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Password Change Dialog */}
      <Dialog open={showPasswordDialog} onOpenChange={setShowPasswordDialog}>
        <DialogContent className="w-[min(calc(100vw-1.5rem),32rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px]">
          <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 text-start pe-12">
            <DialogTitle>{t('password.change')}</DialogTitle>
            <DialogDescription>{t('profile.enterCurrentAndNew')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <Label>{t('password.currentPassword')}</Label>
              <div className="relative">
                <Input type={showPasswords.current ? 'text' : 'password'} value={passwordForm.currentPassword} onChange={(e) => setPasswordForm({ ...passwordForm, currentPassword: e.target.value })} placeholder="••••••••" className="pe-12" dir="ltr" />
                <Button type="button" variant="ghost" size="icon" aria-label={t('password.currentPassword')} onClick={() => setShowPasswords({ ...showPasswords, current: !showPasswords.current })} className="absolute top-1/2 -translate-y-1/2 end-1 text-muted-foreground hover:text-foreground">
                  {showPasswords.current ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t('password.newPassword')}</Label>
              <div className="relative">
                <Input type={showPasswords.new ? 'text' : 'password'} value={passwordForm.newPassword} onChange={(e) => setPasswordForm({ ...passwordForm, newPassword: e.target.value })} placeholder="••••••••" className="pe-12" dir="ltr" />
                <Button type="button" variant="ghost" size="icon" aria-label={t('password.newPassword')} onClick={() => setShowPasswords({ ...showPasswords, new: !showPasswords.new })} className="absolute top-1/2 -translate-y-1/2 end-1 text-muted-foreground hover:text-foreground">
                  {showPasswords.new ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t('password.confirmPassword')}</Label>
              <div className="relative">
                <Input type={showPasswords.confirm ? 'text' : 'password'} value={passwordForm.confirmPassword} onChange={(e) => setPasswordForm({ ...passwordForm, confirmPassword: e.target.value })} placeholder="••••••••" className="pe-12" dir="ltr" />
                <Button type="button" variant="ghost" size="icon" aria-label={t('password.confirmPassword')} onClick={() => setShowPasswords({ ...showPasswords, confirm: !showPasswords.confirm })} className="absolute top-1/2 -translate-y-1/2 end-1 text-muted-foreground hover:text-foreground">
                  {showPasswords.confirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </Button>
              </div>
            </div>
          </DialogBody>
          <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 border-t border-border/60">
            <Button variant="outline" onClick={() => setShowPasswordDialog(false)}>
              {t('password.cancel')}
            </Button>
            <Button onClick={handleChangePassword} disabled={isChangingPassword}>
              {isChangingPassword ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t('profile.changingPassword')}
                </>
              ) : (
                <>
                  <Lock className="w-4 h-4" />
                  {t('password.changeBtn')}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* PIN Setup Dialog */}
      <Dialog open={showPinDialog} onOpenChange={setShowPinDialog}>
        <DialogContent className="w-[min(calc(100vw-1.5rem),32rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px]">
          <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 text-start pe-12">
            <DialogTitle>{t('profile.setQuickPinTitle')}</DialogTitle>
            <DialogDescription>
              {t('profile.setQuickPinDesc')}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <Label>{t('profile.newPinLabel')}</Label>
              <div className="relative">
                <Input
                  type={showPin ? 'text' : 'password'}
                  inputMode="numeric"
                  maxLength={8}
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value.replace(/[^0-9]/g, ''))}
                  placeholder="••••"
                  className="pe-12 font-mono tracking-widest text-center"
                  dir="ltr"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('profile.newPinLabel')}
                  onClick={() => setShowPin(!showPin)}
                  className="absolute top-1/2 -translate-y-1/2 end-1 text-muted-foreground hover:text-foreground"
                >
                  {showPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t('profile.confirmPinLabel')}</Label>
              <Input
                type="password"
                inputMode="numeric"
                maxLength={8}
                value={confirmPin}
                onChange={(e) => setConfirmPin(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="••••"
                className="font-mono tracking-widest text-center"
                dir="ltr"
              />
            </div>
          </DialogBody>
          <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 border-t border-border/60">
            <Button variant="outline" onClick={() => { setShowPinDialog(false); setNewPin(''); setConfirmPin(''); }}>
              {t('password.cancel')}
            </Button>
            <Button onClick={handleSavePin} disabled={isSavingPin || !newPin || newPin.length < 4}>
              {isSavingPin ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t('password.saving')}
                </>
              ) : (
                t('profile.saveEncryptPin')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
