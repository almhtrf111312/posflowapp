import { useState, useRef } from 'react';
import { useAuth } from '@/hooks/auth-context';
import { useUserRole } from '@/hooks/user-role-context';
import { useLanguage } from '@/hooks/language-context';
import { toast as sonnerToast } from '@/lib/sonner-bridge';
import { useLicense } from '@/hooks/license-context';
import { useUsersManagement, UserData } from '@/hooks/use-users-management';
import { isGuestDemoMode } from '@/lib/demo-data';
import { PasswordChangeDialog } from '@/components/settings/PasswordChangeDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogBody,
} from '@/components/ui/dialog';
import {
  Plus,
  Key,
  Edit,
  Trash2,
  User,
  Loader2,
  AlertTriangle,
  Save,
  Eye,
  EyeOff,
} from 'lucide-react';

export function UsersTab() {
  const { t, isRTL } = useLanguage();
  const { user: currentUser } = useAuth();
  const { isBoss } = useUserRole();
  const toast = ({ title, description, variant }: { title?: string; description?: string; variant?: 'destructive' | 'default' }) => {
    if (variant === 'destructive') sonnerToast.error(title || description || '', title && description ? { description } : undefined);
    else sonnerToast.success(title || description || '', title && description ? { description } : undefined);
  };
  const license = useLicense();
  const licenseState = (license as typeof license & { licenseState?: typeof license })?.licenseState || license;
  const { users, isLoading: usersLoading, addUser, updateUserProfile, deleteUser, setUserRefundPermission } = useUsersManagement();
  // D-35: per-user "must open a shift" (store sync settings requireShiftByUser), default on for cashiers, off for others.
  const readRequireMap = (): Record<string, boolean> => {
    try {
      const sync = (JSON.parse(localStorage.getItem('posflow_settings_v1') || '{}')?.syncSettings || {}) as Record<string, unknown>;
      return (sync.requireShiftByUser && typeof sync.requireShiftByUser === 'object') ? sync.requireShiftByUser as Record<string, boolean> : {};
    } catch { return {}; }
  };
  const [requireMap, setRequireMap] = useState<Record<string, boolean>>(readRequireMap);
  const requireShiftFor = (uid: string, isCashierRole: boolean) =>
    typeof requireMap[uid] === 'boolean' ? requireMap[uid] : isCashierRole;
  const saveRequireShift = async (uid: string, value: boolean) => {
    const next = { ...requireMap, [uid]: value };
    setRequireMap(next);
    try {
      const { saveUnifiedStoreSettings, loadUnifiedStoreSettings } = await import('@/lib/store-settings-sync');
      const current = loadUnifiedStoreSettings().syncSettings || {};
      const res = await saveUnifiedStoreSettings({ syncSettings: { ...current, requireShiftByUser: next } });
      if (res && res.success === false) throw new Error(res.message);
      sonnerToast.success(isRTL ? 'تم الحفظ' : 'Saved');
    } catch (err) {
      console.error('[UsersTab] require-shift save failed:', err);
      setRequireMap(requireMap);
      sonnerToast.error(isRTL ? 'لم يُحفظ الإعداد' : 'Not saved');
    }
  };

  // The license copy on this device can be older than a plan change made in Boss: when it says "limit reached",
  // the server (can_add_cashier) decides, and the saved license is refreshed.
  const cashierLimitReachedOnServer = async (): Promise<boolean> => {
    try {
      const { supabase } = await import('@/integrations/supabase/client');
      const { data, error } = await supabase.rpc('can_add_cashier', { _owner_id: currentUser?.id ?? '' });
      if (!error && data === true) {
        void license.checkLicense?.();
        return false;
      }
    } catch (err) {
      console.warn('[UsersTab] can_add_cashier check failed:', err);
    }
    return true;
  };

  const [userDialogOpen, setUserDialogOpen] = useState(false);
  const [deleteUserDialogOpen, setDeleteUserDialogOpen] = useState(false);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [passwordChangeUserId, setPasswordChangeUserId] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<UserData | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [isSavingUser, setIsSavingUser] = useState(false);

  // Edit dialog: refund + must-open-shift are saved together with «حفظ» (null = unchanged / not applicable).
  const [editRefund, setEditRefund] = useState<boolean | null>(null);
  const [editRequireShift, setEditRequireShift] = useState<boolean | null>(null);
  const [userForm, setUserForm] = useState({
    name: '',
    email: '',
    password: '',
    phone: '',
    role: 'cashier' as 'admin' | 'cashier',
    userType: 'cashier' as 'cashier' | 'distributor' | 'pos',
    allowedPages: [] as string[],
  });

  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const userNameInputRef = useRef<HTMLInputElement>(null);
  const userEmailInputRef = useRef<HTMLInputElement>(null);
  const userPasswordInputRef = useRef<HTMLInputElement>(null);

  const handleAddUser = async () => {
    if (isGuestDemoMode()) {
      toast({
        title: isRTL ? 'تنبيه' : 'Notice',
        description: 'إدارة الحسابات تتطلب حساباً رسمياً وغير متاحة في النسخة التجريبية',
      });
      return;
    }

    // قفل عدد الكاشيرات المسموح به في الباقة
    if (!isBoss) {
      const maxAllowedCashiers = Number(licenseState?.maxCashiers) || 1;
      const currentCashiersCount = users.filter(u => u.role === 'cashier' || u.userType === 'cashier').length;

      if (currentCashiersCount >= maxAllowedCashiers && await cashierLimitReachedOnServer()) {
        toast({
          title: isRTL ? 'تنبيه الباقة والترخيص' : 'Plan Limit Reached',
          description: isRTL 
            ? `لقد استنفدت الحد الأقصى للكاشيرات المسموح به في باقتك (${maxAllowedCashiers} كاشير). يرجى ترقية باقتك لإضافة المزيد.`
            : `You have reached the maximum cashiers limit for your plan (${maxAllowedCashiers}). Please upgrade your plan.`,
          variant: 'destructive',
        });
        return;
      }
    }

    setSelectedUser(null);
    setUserForm({ name: '', email: '', password: '', phone: '', role: 'cashier', userType: 'cashier', allowedPages: [] });
    setEmailError('');
    setPasswordError('');
    setUserDialogOpen(true);
  };

  const handleEditUser = (user: UserData) => {
    if (isGuestDemoMode()) {
      toast({
        title: isRTL ? 'تنبيه' : 'Notice',
        description: 'إدارة الحسابات تتطلب حساباً رسمياً وغير متاحة في النسخة التجريبية',
      });
      return;
    }
    setSelectedUser(user);
    const formRole = user.role === 'boss' || user.role === 'admin' ? 'cashier' : user.role;
    setUserForm({
      name: user.name,
      email: '',
      password: '',
      phone: user.phone || '',
      role: formRole as 'admin' | 'cashier',
      userType: user.userType || 'cashier',
      allowedPages: user.allowedPages || [],
    });
    setEditRefund(user.role === 'cashier' && !user.isOwner && user.canRefund !== undefined ? user.canRefund === true : null);
    setEditRequireShift(!user.isOwner ? requireShiftFor(user.user_id, user.role === 'cashier') : null);
    setEmailError('');
    setPasswordError('');
    setUserDialogOpen(true);
  };

  const handleDeleteUser = (user: UserData) => {
    if (isGuestDemoMode()) {
      toast({
        title: isRTL ? 'تنبيه' : 'Notice',
        description: 'إدارة الحسابات تتطلب حساباً رسمياً وغير متاحة في النسخة التجريبية',
      });
      return;
    }
    setSelectedUser(user);
    setDeleteUserDialogOpen(true);
  };

  const confirmDeleteUser = async () => {
    if (selectedUser) {
      setIsSavingUser(true);
      const success = await deleteUser(selectedUser.user_id, selectedUser.id);
      setIsSavingUser(false);
      if (success) {
        setDeleteUserDialogOpen(false);
        setSelectedUser(null);
      }
    }
  };

  const handleSaveUser = async () => {
    if (isGuestDemoMode()) {
      toast({
        title: isRTL ? 'تنبيه' : 'Notice',
        description: 'إدارة الحسابات تتطلب حساباً رسمياً وغير متاحة في النسخة التجريبية',
      });
      return;
    }
    setEmailError('');
    setPasswordError('');

    const trimmedName = userForm.name.trim();
    if (!trimmedName) {
      toast({
        title: t('common.error'),
        description: t('settings.enterUsername'),
        variant: 'destructive',
      });
      userNameInputRef.current?.focus();
      return;
    }

    if (selectedUser) {
      setIsSavingUser(true);
      const nameChanged = trimmedName !== selectedUser.name;
      const userTypeChanged = userForm.userType !== selectedUser.userType;
      const phoneChanged = userForm.phone !== (selectedUser.phone || '');
      const pagesChanged = JSON.stringify(userForm.allowedPages) !== JSON.stringify(selectedUser.allowedPages || []);

      let success = true;

      if (nameChanged || userTypeChanged || phoneChanged || pagesChanged) {
        success = await updateUserProfile(
          selectedUser.user_id,
          trimmedName,
          userForm.userType,
          userForm.phone,
          userForm.allowedPages.length > 0 ? userForm.allowedPages : null
        );
      }

      // Permissions shown as switches in this dialog are applied on «حفظ» too.
      if (success && editRefund !== null && editRefund !== (selectedUser.canRefund === true)) {
        const ok = await setUserRefundPermission(selectedUser.user_id, editRefund);
        if (ok === false) success = false;
      }
      if (success && editRequireShift !== null && editRequireShift !== requireShiftFor(selectedUser.user_id, selectedUser.role === 'cashier')) {
        await saveRequireShift(selectedUser.user_id, editRequireShift);
      }

      if (success) {
        setUserDialogOpen(false);
        setSelectedUser(null);
        setUserForm({ name: '', email: '', password: '', phone: '', role: 'cashier', userType: 'cashier', allowedPages: [] });
      }
      setIsSavingUser(false);
    } else {
      const trimmedEmail = userForm.email.trim().toLowerCase();
      const rawPassword = userForm.password;

      if (!trimmedEmail) {
        setEmailError('يرجى إدخال البريد الإلكتروني');
        toast({
          title: t('common.error'),
          description: 'يرجى إدخال البريد الإلكتروني',
          variant: 'destructive',
        });
        userEmailInputRef.current?.focus();
        return;
      }

      const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
      if (!emailRegex.test(trimmedEmail)) {
        setEmailError('صيغة البريد الإلكتروني غير صالحة (مثال: user@example.com)');
        toast({
          title: t('common.error'),
          description: 'صيغة البريد الإلكتروني غير صالحة، تأكد من كتابة البريد بشكل صحيح',
          variant: 'destructive',
        });
        userEmailInputRef.current?.focus();
        return;
      }

      if (!rawPassword) {
        setPasswordError('يرجى إدخال كلمة المرور');
        toast({
          title: t('common.error'),
          description: 'يرجى إدخال كلمة المرور',
          variant: 'destructive',
        });
        userPasswordInputRef.current?.focus();
        return;
      }

      if (rawPassword.length < 6) {
        setPasswordError('يجب أن تتكون كلمة المرور من 6 أحرف على الأقل');
        toast({
          title: t('common.error'),
          description: t('settings.passwordTooShort') || 'كلمة المرور يجب أن لا تقل عن 6 أحرف',
          variant: 'destructive',
        });
        userPasswordInputRef.current?.focus();
        return;
      }

      // قفل إضافي قبل الحفظ لمنع تجاوز حد الكاشيرات
      if (!isBoss) {
        const maxAllowedCashiers = Number(licenseState?.maxCashiers) || 1;
        const currentCashiersCount = users.filter(u => u.role === 'cashier' || u.userType === 'cashier').length;

        if (currentCashiersCount >= maxAllowedCashiers && await cashierLimitReachedOnServer()) {
          toast({
            title: isRTL ? 'تنبيه الباقة والترخيص' : 'Plan Limit Reached',
            description: isRTL 
              ? `لقد استنفدت الحد الأقصى للكاشيرات المسموح به في باقتك (${maxAllowedCashiers} كاشير). يرجى ترقية باقتك لإضافة المزيد.`
              : `You have reached the maximum cashiers limit for your plan (${maxAllowedCashiers}). Please upgrade your plan.`,
            variant: 'destructive',
          });
          return;
        }
      }

      setIsSavingUser(true);

      const success = await addUser(
        trimmedEmail,
        rawPassword,
        trimmedName,
        userForm.role,
        userForm.userType,
        userForm.phone?.trim() || undefined,
        userForm.allowedPages.length > 0 ? userForm.allowedPages : undefined
      );

      if (success) {
        setUserDialogOpen(false);
        setUserForm({ name: '', email: '', password: '', phone: '', role: 'cashier', userType: 'cashier', allowedPages: [] });
      }

      setIsSavingUser(false);
    }
  };

  return (
    <div className="space-y-4">
      {isGuestDemoMode() && (
        <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl flex items-center gap-2.5 text-xs text-amber-800 dark:text-amber-300">
          <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span>إدارة الحسابات وتعيين كلمات المرور تتطلب حساباً رسمياً وغير متاحة في النسخة التجريبية.</span>
        </div>
      )}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-base sm:text-lg font-bold text-foreground">{t('settings.userManagement')}</h2>
          {!isBoss && (
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
              {users.filter(u => u.role === 'cashier' || u.userType === 'cashier').length} / {Number(licenseState?.maxCashiers) || 1} {isRTL ? 'كاشير متاح' : 'cashiers'}
            </span>
          )}
        </div>
        <Button onClick={handleAddUser} className="w-full sm:w-auto">
          <Plus className="w-4 h-4 shrink-0" />
          {t('settings.addUser')}
        </Button>
      </div>
      <div className="space-y-2.5">
        {usersLoading ? (
          <div className="text-center py-8 text-muted-foreground">
            <Loader2 className="w-8 h-8 mx-auto mb-2 animate-spin text-primary" />
            {t('common.loading')}
          </div>
        ) : users.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground bg-muted/20 rounded-xl p-4">
            {t('settings.noUsers')}
          </div>
        ) : (
          users
            .filter((user) => user.role !== 'boss')
            .map((user) => (
              <div key={user.id} className="flex flex-col gap-2 p-3.5 bg-muted/40 rounded-xl border border-border/50">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
                    <User className="w-4 h-4 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-foreground text-sm truncate">{user.name}</p>
                    {user.email && (
                      <p className="text-xs text-muted-foreground truncate font-mono">{user.email}</p>
                    )}
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {user.role === 'admin' ? t('settings.userTypeOwner') :
                        user.userType === 'distributor' ? t('settings.userTypeDistributor') :
                          user.userType === 'pos' ? t('settings.userTypePOS') :
                            t('settings.cashier')}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 border-t border-border/40 pt-2">
                  {(!user.isOwner || isBoss || user.role === 'cashier') && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 h-8 gap-1 text-xs border-primary/30 text-primary hover:bg-primary/10 hover:text-primary transition-colors font-medium shadow-none"
                      onClick={() => {
                        if (isGuestDemoMode()) {
                          toast({
                            title: isRTL ? 'تنبيه' : 'Notice',
                            description: 'إدارة الحسابات تتطلب حساباً رسمياً وغير متاحة في النسخة التجريبية',
                          });
                          return;
                        }
                        setPasswordChangeUserId(user.user_id || user.id);
                        setSelectedUser(user);
                        setPasswordDialogOpen(true);
                      }}
                      title={isRTL ? 'تغيير كلمة المرور' : 'Change Password'}
                    >
                      <Key className="w-3.5 h-3.5 text-primary shrink-0" />
                      <span>{isRTL ? 'كلمة المرور' : t('settings.password')}</span>
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" className="flex-1 h-8 gap-1 text-xs" onClick={() => handleEditUser(user)}>
                    <Edit className="w-3 h-3" />
                    <span>{t('common.edit')}</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="flex-1 h-8 gap-1 text-xs text-destructive"
                    onClick={() => handleDeleteUser(user)}
                    disabled={user.user_id === currentUser?.id || user.isOwner}
                  >
                    <Trash2 className="w-3 h-3" />
                    <span>{t('common.delete')}</span>
                  </Button>
                </div>
                {user.role === 'cashier' && !user.isOwner && (
                  <div className="flex items-center justify-between gap-3 pt-2 mt-2 border-t border-border/60">
                    <div className="min-w-0">
                      <p className="text-xs font-medium">{isRTL ? 'السماح بالاسترداد' : 'Allow refunds'}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {isRTL ? 'يستطيع هذا الكاشير استرداد الفواتير' : 'This cashier can refund invoices'}
                      </p>
                    </div>
                    <Switch
                      checked={user.canRefund === true}
                      disabled={user.canRefund === undefined || isGuestDemoMode()}
                      onCheckedChange={(allowed) => { void setUserRefundPermission(user.user_id, allowed); }}
                    />
                  </div>
                )}
                {!user.isOwner && (
                  <div className="flex items-center justify-between gap-3 pt-2 mt-2 border-t border-border/60">
                    <div className="min-w-0">
                      <p className="text-xs font-medium">{isRTL ? 'إلزام فتح وردية' : 'Must open a shift'}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {isRTL ? 'بدون وردية لا يبيع نقداً؛ عند الإيقاف تذهب عملياته النقدية إلى الصندوق العام' : 'Without a shift no cash sales; when off, cash goes to the general drawer'}
                      </p>
                    </div>
                    <Switch
                      checked={requireShiftFor(user.user_id, user.role === 'cashier')}
                      disabled={isGuestDemoMode()}
                      onCheckedChange={(v) => { void saveRequireShift(user.user_id, v); }}
                    />
                  </div>
                )}
              </div>
            ))
        )}
      </div>

      {/* User Form Dialog */}
      <Dialog open={userDialogOpen} onOpenChange={setUserDialogOpen}>
        <DialogContent
          className="w-[min(calc(100vw-1.5rem),32rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px]"
          onPointerDownOutside={(e) => { if (isSavingUser || userForm.name.trim()) e.preventDefault(); }}
          onEscapeKeyDown={(e) => { if (isSavingUser || userForm.name.trim()) e.preventDefault(); }}
        >
          <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 text-start pe-12">
            <DialogTitle>{selectedUser ? t('settings.editUser') : t('settings.addUser')}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{isRTL ? 'اسم المستخدم' : 'User name'}</label>
              <Input
                ref={userNameInputRef}
                value={userForm.name}
                onChange={(e) => setUserForm({ ...userForm, name: e.target.value })}
                placeholder={isRTL ? 'اسم المستخدم' : 'User name'}
              />
            </div>
            {!selectedUser && (
              <>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">{t('common.email')}</label>
                  <Input
                    ref={userEmailInputRef}
                    type="email"
                    dir="ltr"
                    value={userForm.email}
                    onChange={(e) => {
                      setUserForm({ ...userForm, email: e.target.value });
                      if (emailError) setEmailError('');
                    }}
                    placeholder="email@example.com"
                    className={`text-start placeholder:text-start ${emailError ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                  />
                  {emailError && (
                    <p className="text-xs text-destructive font-medium">{emailError}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">{t('auth.password')}</label>
                  <div className="relative">
                    <Input
                      ref={userPasswordInputRef}
                      type={showPassword ? 'text' : 'password'}
                      dir="ltr"
                      value={userForm.password}
                      onChange={(e) => {
                        setUserForm({ ...userForm, password: e.target.value });
                        if (passwordError) setPasswordError('');
                      }}
                      placeholder={t('auth.password')}
                      className={`text-start placeholder:text-start pe-12 ${passwordError ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setShowPassword(!showPassword)}
                      aria-label={t('auth.password')}
                      className="absolute end-1 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </Button>
                  </div>
                  {passwordError && (
                    <p className="text-xs text-destructive font-medium">{passwordError}</p>
                  )}
                </div>
              </>
            )}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('settings.phoneOptional')}</label>
              <Input
                type="tel"
                value={userForm.phone}
                onChange={(e) => setUserForm({ ...userForm, phone: e.target.value })}
                placeholder="09XXXXXXXX / +963... / +90..."
                dir="ltr"
                className="font-mono text-start tabular-nums"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('settings.userTypeLabel')}</label>
              <select
                value={userForm.userType}
                onChange={(e) => setUserForm({ ...userForm, userType: e.target.value as 'cashier' | 'distributor' | 'pos' })}
                className="w-full h-10 px-3 rounded-md bg-muted border-0"
              >
                <option value="cashier">{t('settings.userTypeCashierOption')}</option>
                <option value="pos">{t('settings.userTypePOSOption')}</option>
                <option value="distributor">{t('settings.userTypeDistributorOption')}</option>
              </select>
              <p className="text-xs text-muted-foreground">
                {userForm.userType === 'cashier'
                  ? t('settings.userTypeCashierDesc')
                  : userForm.userType === 'pos'
                    ? t('settings.userTypePOSDesc')
                    : t('settings.userTypeDistributorDesc')}
              </p>
            </div>
            {/* Allowed Pages */}
            <div className="space-y-2">
              <label className="text-sm font-medium">{isRTL ? 'القوائم المسموح بها' : 'Allowed Pages'}</label>
              <p className="text-xs text-muted-foreground">
                {isRTL ? 'حدد القوائم الإضافية التي يستطيع هذا المستخدم الوصول إليها' : 'Select additional pages this user can access'}
              </p>
              <div className="space-y-1.5 pt-1">
                {[
                  { key: 'products', label: isRTL ? 'المنتجات (عرض فقط)' : 'Products (view only)' },
                  { key: 'reports', label: t('nav.reports') },
                  { key: 'settings', label: t('nav.settings') },
                ].map(page => (
                  <div key={page.key} className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2">
                    <span className="text-sm">{page.label}</span>
                    <Switch
                      checked={userForm.allowedPages.includes(page.key)}
                      onCheckedChange={(on) => setUserForm(prev => ({
                        ...prev,
                        allowedPages: on
                          ? [...prev.allowedPages.filter(p => p !== page.key), page.key]
                          : prev.allowedPages.filter(p => p !== page.key && !(page.key === 'products' && p === 'products:add')),
                      }))}
                    />
                  </div>
                ))}
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm">{isRTL ? 'إمكانية إضافة المنتجات' : 'Can Add Products'}</p>
                    <p className="text-xs text-muted-foreground">{isRTL ? 'يسمح للكاشير بإضافة منتجات جديدة وتعديلها' : 'Allows cashier to add and edit products'}</p>
                  </div>
                  <Switch
                    checked={userForm.allowedPages.includes('products:add')}
                    onCheckedChange={(on) => setUserForm(prev => ({
                      ...prev,
                      allowedPages: on
                        ? [...prev.allowedPages.filter(p => p !== 'products:add' && p !== 'products'), 'products', 'products:add']
                        : prev.allowedPages.filter(p => p !== 'products:add'),
                    }))}
                  />
                </div>
                {selectedUser && editRefund !== null && (
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm">{isRTL ? 'السماح بالاسترداد' : 'Allow refunds'}</p>
                      <p className="text-xs text-muted-foreground">{isRTL ? 'يستطيع هذا الكاشير استرداد الفواتير' : 'This cashier can refund invoices'}</p>
                    </div>
                    <Switch checked={editRefund} onCheckedChange={setEditRefund} />
                  </div>
                )}
                {selectedUser && editRequireShift !== null && (
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm">{isRTL ? 'إلزام فتح وردية' : 'Must open a shift'}</p>
                      <p className="text-xs text-muted-foreground">{isRTL ? 'عند الإيقاف تذهب عملياته النقدية بلا وردية إلى الصندوق العام' : 'When off, cash without a shift goes to the general drawer'}</p>
                    </div>
                    <Switch checked={editRequireShift} onCheckedChange={setEditRequireShift} />
                  </div>
                )}
              </div>
            </div>
          </DialogBody>
          <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 border-t border-border/60">
            <Button variant="outline" onClick={() => setUserDialogOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={handleSaveUser} disabled={isSavingUser}>
              {isSavingUser ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete User Dialog */}
      <Dialog open={deleteUserDialogOpen} onOpenChange={setDeleteUserDialogOpen}>
        <DialogContent className="w-[min(calc(100vw-1.5rem),28rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px]">
          <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 text-start pe-12">
            <DialogTitle>{t('common.confirmDelete')}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="text-sm text-muted-foreground">{t('settings.confirmDeleteUser')} "{selectedUser?.name}"?</p>
          </DialogBody>
          <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 border-t border-border/60">
            <Button variant="outline" onClick={() => setDeleteUserDialogOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={confirmDeleteUser} disabled={isSavingUser}>
              {isSavingUser ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Password Change Dialog */}
      <PasswordChangeDialog
        open={passwordDialogOpen}
        onOpenChange={(open) => {
          setPasswordDialogOpen(open);
          if (!open) {
            setPasswordChangeUserId(null);
          }
        }}
        userId={passwordChangeUserId || selectedUser?.user_id || selectedUser?.id || undefined}
        userName={users.find(u => (u.user_id === passwordChangeUserId || u.id === passwordChangeUserId))?.name || selectedUser?.name}
        isOwnPassword={passwordChangeUserId ? passwordChangeUserId === currentUser?.id : false}
      />
    </div>
  );
}

export default UsersTab;
