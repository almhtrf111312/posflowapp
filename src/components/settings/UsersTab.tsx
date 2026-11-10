import { useState, useRef } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { useUserRole } from '@/hooks/use-user-role';
import { useLanguage } from '@/hooks/use-language';
import { useToast } from '@/hooks/use-toast';
import { useLicense } from '@/hooks/use-license';
import { useUsersManagement, UserData } from '@/hooks/use-users-management';
import { isGuestDemoMode } from '@/lib/demo-data';
import { PasswordChangeDialog } from '@/components/settings/PasswordChangeDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
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
  const { toast } = useToast();
  const license = useLicense();
  const licenseState = (license as any)?.licenseState || license;
  const { users, isLoading: usersLoading, addUser, updateUserProfile, deleteUser } = useUsersManagement();

  const [userDialogOpen, setUserDialogOpen] = useState(false);
  const [deleteUserDialogOpen, setDeleteUserDialogOpen] = useState(false);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [passwordChangeUserId, setPasswordChangeUserId] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<UserData | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [isSavingUser, setIsSavingUser] = useState(false);

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

  const handleAddUser = () => {
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

      if (currentCashiersCount >= maxAllowedCashiers) {
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

        if (currentCashiersCount >= maxAllowedCashiers) {
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
        <Button onClick={handleAddUser} className="w-full sm:w-auto h-9">
          <Plus className="w-4 h-4" />
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
              </div>
            ))
        )}
      </div>

      {/* User Form Dialog */}
      <Dialog open={userDialogOpen} onOpenChange={setUserDialogOpen}>
        <DialogContent className="max-w-md w-[95vw] rounded-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{selectedUser ? t('settings.editUser') : t('settings.addUser')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('settings.username' as any)}</label>
              <Input
                ref={userNameInputRef}
                value={userForm.name}
                onChange={(e) => setUserForm({ ...userForm, name: e.target.value })}
                placeholder={t('settings.username' as any)}
              />
            </div>
            {!selectedUser && (
              <>
                <div className="space-y-2">
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
                    className={`text-left placeholder:text-right ${emailError ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                  />
                  {emailError && (
                    <p className="text-xs text-destructive font-medium">{emailError}</p>
                  )}
                </div>
                <div className="space-y-2">
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
                      className={`text-left placeholder:text-right pr-10 ${passwordError ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                      tabIndex={-1}
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  {passwordError && (
                    <p className="text-xs text-destructive font-medium">{passwordError}</p>
                  )}
                </div>
              </>
            )}
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('settings.phoneOptional')}</label>
              <Input
                type="tel"
                value={userForm.phone}
                onChange={(e) => setUserForm({ ...userForm, phone: e.target.value })}
                placeholder="09XXXXXXXX / +963... / +90..."
                dir="ltr"
                className="font-mono text-left"
              />
            </div>
            <div className="space-y-2">
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
              <div className="grid grid-cols-2 gap-2 pt-1">
                {[
                  { key: 'dashboard', label: t('nav.dashboard') },
                  { key: 'products', label: isRTL ? 'المنتجات (عرض فقط)' : 'Products (view only)' },
                  { key: 'partners', label: t('nav.partners') },
                  { key: 'reports', label: t('nav.reports') },
                  { key: 'settings', label: t('nav.settings') },
                ].map(page => (
                  <label key={page.key} className="flex items-center gap-2 text-sm cursor-pointer p-1.5 rounded-lg hover:bg-muted">
                    <input
                      type="checkbox"
                      checked={userForm.allowedPages.includes(page.key)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setUserForm(prev => ({ ...prev, allowedPages: [...prev.allowedPages, page.key] }));
                        } else {
                          setUserForm(prev => ({ ...prev, allowedPages: prev.allowedPages.filter(p => p !== page.key) }));
                        }
                      }}
                      className="w-4 h-4 rounded border-primary text-primary accent-primary"
                    />
                    {page.label}
                  </label>
                ))}
              </div>
              {(userForm.allowedPages.includes('products') || userForm.role === 'cashier') && (
                <div className="mt-2 p-2.5 bg-muted/60 rounded-lg border border-border/50">
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={userForm.allowedPages.includes('products:add')}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setUserForm(prev => ({
                            ...prev,
                            allowedPages: [...prev.allowedPages.filter(p => p !== 'products:add'), 'products:add',
                              ...(!prev.allowedPages.includes('products') ? ['products'] : [])
                            ]
                          }));
                        } else {
                          setUserForm(prev => ({ ...prev, allowedPages: prev.allowedPages.filter(p => p !== 'products:add') }));
                        }
                      }}
                      className="w-4 h-4 rounded border-primary text-primary accent-primary"
                    />
                    <div>
                      <span className="font-medium">{isRTL ? 'إمكانية إضافة المنتجات' : 'Can Add Products'}</span>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {isRTL ? 'يسمح للكاشير بإضافة منتجات جديدة وتعديلها' : 'Allows cashier to add and edit products'}
                      </p>
                    </div>
                  </label>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
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
        <DialogContent className="max-w-sm w-[95vw] rounded-2xl">
          <DialogHeader>
            <DialogTitle>{t('common.confirmDelete')}</DialogTitle>
          </DialogHeader>
          <p className="py-4">{t('settings.confirmDeleteUser')} "{selectedUser?.name}"?</p>
          <DialogFooter>
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
