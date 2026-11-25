import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/auth-context';
import { addActivityLog } from '@/lib/activity-log';
import { isGuestDemoMode } from '@/lib/demo-data';
import { normalizePhoneNumber } from '@/lib/phone-utils';

export type UserType = 'cashier' | 'distributor' | 'pos';

export interface UserData {
  id: string;
  user_id: string;
  name: string;
  email: string;
  phone?: string;
  role: 'admin' | 'cashier' | 'boss';
  userType?: UserType;
  allowedPages?: string[] | null;
  /** صلاحية الاسترداد للكاشير. undefined = غير معروفة (العمود غير متاح بعد أو تعذّر الجلب) */
  canRefund?: boolean;
  isCurrentUser?: boolean;
  isOwner?: boolean;
}

export function useUsersManagement() {
  const { toast } = useToast();
  const { user: currentUser, profile } = useAuth();
  const [users, setUsers] = useState<UserData[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchUsers = useCallback(async () => {
    // In Guest Demo Mode, return mock demo user without contacting Supabase
    if (isGuestDemoMode()) {
      setIsLoading(false);
      setUsers([
        {
          id: 'demo-user-1',
          user_id: 'guest-demo-user',
          name: profile?.full_name || 'مدير الحساب التجريبي',
          email: 'demo@posflow.local',
          phone: '',
          role: 'admin',
          userType: 'cashier',
          allowedPages: null,
          isCurrentUser: true,
          isOwner: true,
        },
      ]);
      return;
    }

    try {
      setIsLoading(true);
      
      // Fetch all user roles with profiles
      const { data: rolesData, error: rolesError } = await supabase
        .from('user_roles')
        .select('id, user_id, role, created_at, owner_id');

      if (rolesError) {
        console.error('Error fetching roles:', rolesError);
        toast({
          title: 'خطأ',
          description: 'فشل في جلب بيانات المستخدمين',
          variant: 'destructive',
        });
        return;
      }

      // صلاحية الاسترداد لكل كاشير: استعلام مستقل حتى لا يتعطل جلب المستخدمين إن لم يكن العمود متاحاً بعد
      let refundByUser: Map<string, boolean> | null = null;
      try {
        const { data: refundRows, error: refundError } = await supabase
          .from('user_roles')
          .select('user_id, can_refund');
        if (!refundError && Array.isArray(refundRows)) {
          refundByUser = new Map(refundRows.map((r: { user_id: string; can_refund: boolean | null }) => [r.user_id, r.can_refund === true]));
        }
      } catch {
        refundByUser = null;
      }

      // Fetch profiles for each user (including phone, user_type, and allowed_pages)
      const { data: profilesData, error: profilesError } = await supabase
        .from('profiles')
        .select('user_id, full_name, phone, user_type, allowed_pages');

      if (profilesError) {
        console.error('Error fetching profiles:', profilesError);
      }

      // Get the first admin/boss (owner) - sorted by created_at
      const sortedRoles = [...(rolesData || [])].sort((a, b) => 
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
      const ownerUserId = sortedRoles.find(r => r.role === 'admin' || r.role === 'boss')?.user_id;

      console.log(`[Users] Fetched ${rolesData?.length} roles, ${profilesData?.length} profiles`);

      // Fetch emails for all users via edge function
      const userIds = rolesData.map(r => r.user_id);
      let emailMap: Record<string, string> = {};
      
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.access_token && userIds.length > 0) {
          const { data: emailsData, error: emailsError } = await supabase.functions.invoke('get-users-emails', {
            body: { userIds },
            headers: { Authorization: `Bearer ${session.access_token}` },
          });
          if (!emailsError && emailsData?.emails) {
            emailMap = emailsData.emails;
          } else if (emailsError) {
            console.warn('[Users] emails unavailable:', emailsError.message);
          }
        }
      } catch (e) {
        console.warn('Error fetching user emails:', e);
      }

      // Combine data
      const combinedUsers: UserData[] = rolesData.map(role => {
        const userProfile = profilesData?.find(p => p.user_id === role.user_id);
        const isCurrentUserFlag = currentUser?.id === role.user_id;
        const isOwnerFlag = role.user_id === ownerUserId;
        
        // Get email from emailMap, or use current user's email
        const userEmail = emailMap[role.user_id] || (isCurrentUserFlag ? (currentUser?.email || '') : '');
        
        // For admin/boss roles, userType should be derived from role, not profiles.user_type
        // user_type in profiles is only relevant for cashier role (cashier vs distributor vs pos)
        const dbRole = role.role as 'admin' | 'cashier' | 'boss';
        let userType: UserType = 'cashier';
        
        // Only use user_type from profiles for cashier role
        if (dbRole === 'cashier') {
          userType = (userProfile?.user_type as UserType) || 'cashier';
        }
        
        return {
          id: role.id,
          user_id: role.user_id,
          name: userProfile?.full_name || (isCurrentUserFlag ? (profile?.full_name || currentUser?.email?.split('@')[0] || 'مستخدم') : 'بدون اسم'),
          email: userEmail,
          phone: userProfile?.phone || '',
          role: dbRole,
          userType: userType,
          allowedPages: Array.isArray(userProfile?.allowed_pages) ? userProfile.allowed_pages as string[] : null,
          canRefund: refundByUser ? refundByUser.get(role.user_id) === true : undefined,
          isCurrentUser: isCurrentUserFlag,
          isOwner: isOwnerFlag,
        };
      });

      // Sort: owner first, then current user, then others
      combinedUsers.sort((a, b) => {
        if (a.isOwner && !b.isOwner) return -1;
        if (!a.isOwner && b.isOwner) return 1;
        if (a.isCurrentUser && !b.isCurrentUser) return -1;
        if (!a.isCurrentUser && b.isCurrentUser) return 1;
        return 0;
      });

      setUsers(combinedUsers);
    } catch (error) {
      console.error('Error in fetchUsers:', error);
    } finally {
      setIsLoading(false);
    }
  }, [toast, currentUser, profile]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const addUser = async (email: string, password: string, fullName: string, role: 'admin' | 'cashier', userType: UserType = 'cashier', phone?: string, allowedPages?: string[]) => {
    if (isGuestDemoMode()) {
      toast({
        title: 'تنبيه',
        description: 'إدارة الحسابات تتطلب حساباً رسمياً وغير متاحة في النسخة التجريبية',
      });
      return false;
    }

    try {
      // Ensure user is logged in
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        toast({
          title: 'خطأ',
          description: 'يجب تسجيل الدخول لإنشاء مستخدمين',
          variant: 'destructive',
        });
        return false;
      }

      // Check owner license and cashier capacity before creating user
      const { data: roleRow } = await supabase
        .from('user_roles')
        .select('role, owner_id')
        .eq('user_id', session.user.id)
        .maybeSingle();

      const isBoss = roleRow?.role === 'boss';
      const ownerId = (roleRow?.role === 'cashier' && roleRow.owner_id)
        ? roleRow.owner_id
        : session.user.id;

      if (!isBoss) {
        const { data: canAdd, error: canAddError } = await supabase.rpc('can_add_cashier', {
          _owner_id: ownerId,
        });

        if (canAddError) {
          console.error('Error checking cashier limit:', canAddError);
        } else if (canAdd === false) {
          toast({
            title: 'خطأ في الترخيص',
            description: 'لا يمكنك إضافة كاشير جديد: انتهت صلاحية الترخيص أو تم الوصول للحد الأقصى المسموح من الكاشيرات',
            variant: 'destructive',
          });
          return false;
        }
      }

      // Normalize email and phone to standard format
      const normalizedEmail = email.trim().toLowerCase();
      const normalizedPhone = phone ? normalizePhoneNumber(phone) : undefined;

      // Pre-check phone and email availability via database function
      if (normalizedPhone || normalizedEmail) {
        try {
          const { data: checkResult, error: checkError } = await supabase.rpc('check_phone_email_availability', {
            _phone: normalizedPhone || '',
            _email: normalizedEmail,
          });

          if (!checkError && checkResult && !(checkResult as { available?: boolean }).available) {
            toast({
              title: 'خطأ في التحقق',
              description: (checkResult as { error?: string }).error || 'البريد الإلكتروني أو رقم الهاتف غير متاح',
              variant: 'destructive',
            });
            return false;
          }
        } catch (err) {
          console.warn('[Users] Pre-check availability error:', err);
        }
      }

      // Call backend function to create the user - this won't affect the current session
      const { data, error } = await supabase.functions.invoke('create-user', {
        body: { email: normalizedEmail, password, fullName, role, userType, phone: normalizedPhone, allowedPages },
      });

      let errorMessage = '';

      if (error) {
        console.error('Error calling create-user:', error);
        try {
          if ((error as { context?: { json?: () => Promise<unknown> } }).context && typeof (error as { context?: { json?: () => Promise<unknown> } }).context.json === 'function') {
            const errorBody = await (error as { context: { json: () => Promise<unknown> } }).context.json() as { error?: string } | null;
            if (errorBody?.error) {
              errorMessage = errorBody.error;
            }
          }
        } catch (e) {
          console.warn('Could not read error context body:', e);
        }

        if (!errorMessage) {
          errorMessage = error.message || '';
        }
      } else if (!data?.success) {
        errorMessage = data?.error || '';
      }

      if (errorMessage) {
        let userFacingError = errorMessage;
        const lowerErr = errorMessage.toLowerCase();

        if (
          lowerErr.includes('user already registered') ||
          lowerErr.includes('already registered') ||
          lowerErr.includes('already exists') ||
          lowerErr.includes('already in use')
        ) {
          userFacingError = 'البريد الإلكتروني مسجل مسبقاً لمستخدم آخر، يرجى استخدام بريد إلكتروني مختلف';
        } else if (
          (lowerErr.includes('invalid') && lowerErr.includes('email')) ||
          lowerErr.includes('unable to validate email') ||
          lowerErr.includes('invalid format')
        ) {
          userFacingError = 'صيغة البريد الإلكتروني غير صالحة، يرجى التأكد من كتابة البريد بشكل صحيح';
        } else if (
          lowerErr.includes('password') && (lowerErr.includes('6') || lowerErr.includes('least'))
        ) {
          userFacingError = 'يجب أن تتكون كلمة المرور من 6 أحرف على الأقل';
        }

        toast({
          title: 'خطأ',
          description: userFacingError,
          variant: 'destructive',
        });
        return false;
      }

      // Log activity
      if (currentUser) {
        addActivityLog(
          'user_added',
          currentUser.id,
          profile?.full_name || currentUser.email || 'مستخدم',
          `تم إضافة مستخدم جديد: ${fullName} (${role === 'admin' ? 'مدير' : 'كاشير'})`,
          { email: normalizedEmail, role, newUserId: data?.user?.id }
        );
      }

      toast({
        title: 'تمت الإضافة',
        description: `تم إضافة المستخدم ${fullName} بنجاح`,
      });

      await fetchUsers();
      return true;
    } catch (error) {
      console.error('Error adding user:', error);
      toast({
        title: 'خطأ',
        description: 'حدث خطأ أثناء إضافة المستخدم',
        variant: 'destructive',
      });
      return false;
    }
  };

  const updateUserRole = async (userId: string, newRole: 'admin' | 'cashier') => {
    if (isGuestDemoMode()) {
      toast({
        title: 'تنبيه',
        description: 'إدارة الحسابات تتطلب حساباً رسمياً وغير متاحة في النسخة التجريبية',
      });
      return false;
    }

    try {
      // Admins can only assign 'cashier' role to their sub-accounts.
      // Promoting to 'admin' is restricted to boss accounts via RLS WITH CHECK.
      if (newRole !== 'cashier') {
        toast({
          title: 'غير مسموح',
          description: 'لا يمكن ترقية المستخدم إلى مدير',
          variant: 'destructive',
        });
        return false;
      }
      const { error } = await supabase
        .from('user_roles')
        .update({ role: newRole })
        .eq('user_id', userId);


      if (error) {
        toast({
          title: 'خطأ',
          description: 'فشل في تحديث صلاحية المستخدم',
          variant: 'destructive',
        });
        return false;
      }

      toast({
        title: 'تم التحديث',
        description: 'تم تحديث صلاحية المستخدم بنجاح',
      });

      await fetchUsers();
      return true;
    } catch (error) {
      console.error('Error updating role:', error);
      return false;
    }
  };

  const updateUserProfile = async (userId: string, fullName: string, userType?: UserType, phone?: string, allowedPages?: string[] | null) => {
    if (isGuestDemoMode()) {
      toast({
        title: 'تنبيه',
        description: 'إدارة الحسابات تتطلب حساباً رسمياً وغير متاحة في النسخة التجريبية',
      });
      return false;
    }

    try {
      const normalizedPhone = phone !== undefined ? (phone.trim() ? normalizePhoneNumber(phone) : null) : undefined;

      if (normalizedPhone) {
        try {
          const { data: checkResult, error: checkError } = await supabase.rpc('check_phone_email_availability', {
            _phone: normalizedPhone,
            _email: '',
            _exclude_user_id: userId,
          });

          if (!checkError && checkResult && !(checkResult as { available?: boolean }).available) {
            toast({
              title: 'خطأ في التحقق',
              description: (checkResult as { error?: string }).error || 'رقم الهاتف مسجل بالفعل لحساب آخر',
              variant: 'destructive',
            });
            return false;
          }
        } catch (err) {
          console.warn('[Users] Pre-check phone availability error:', err);
        }
      }

      const updateData: { full_name: string; user_type?: string; phone?: string | null; allowed_pages?: string[] | null } = { full_name: fullName };
      
      if (userType) {
        updateData.user_type = userType;
      }
      
      if (normalizedPhone !== undefined) {
        updateData.phone = normalizedPhone;
      }

      if (allowedPages !== undefined) {
        updateData.allowed_pages = allowedPages;
      }

      console.log('Updating profile for user:', userId, 'with data:', updateData);

      // Use .select() to verify if rows were actually updated
      const { data, error } = await supabase
        .from('profiles')
        .update(updateData)
        .eq('user_id', userId)
        .select('user_id, full_name, user_type, phone');

      if (error) {
        console.error('Error updating profile:', error);
        const isUniqueError = error.message?.includes('unique') || (error as { code?: string }).code === '23505';
        toast({
          title: 'خطأ',
          description: isUniqueError
            ? 'رقم الهاتف مسجل بالفعل لحساب مستخدم آخر ولا يمكن استخدامه'
            : 'فشل في تحديث بيانات المستخدم: ' + error.message,
          variant: 'destructive',
        });
        return false;
      }

      // Check if any rows were actually updated
      if (!data || data.length === 0) {
        console.error('No rows updated - possibly RLS restriction');
        toast({
          title: 'خطأ في الصلاحيات',
          description: 'لم يتم تحديث أي بيانات - تحقق من صلاحياتك',
          variant: 'destructive',
        });
        return false;
      }

      console.log('Profile updated successfully:', data);

      toast({
        title: 'تم التحديث',
        description: 'تم تحديث بيانات المستخدم بنجاح',
      });

      await fetchUsers();
      return true;
    } catch (error) {
      console.error('Error updating profile:', error);
      toast({
        title: 'خطأ',
        description: 'حدث خطأ أثناء تحديث البيانات',
        variant: 'destructive',
      });
      return false;
    }
  };

  const deleteUser = async (userId: string, roleId: string, userName?: string) => {
    if (isGuestDemoMode()) {
      toast({
        title: 'تنبيه',
        description: 'إدارة الحسابات تتطلب حساباً رسمياً وغير متاحة في النسخة التجريبية',
      });
      return false;
    }

    try {
      // Ensure user is logged in
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        toast({
          title: 'خطأ',
          description: 'يجب تسجيل الدخول لحذف المستخدمين',
          variant: 'destructive',
        });
        return false;
      }

      // Call backend function to delete the user completely
      const { data, error } = await supabase.functions.invoke('delete-user', {
        body: { userId },
      });

      if (error) {
        toast({
          title: 'خطأ',
          description: error.message || 'فشل في حذف المستخدم',
          variant: 'destructive',
        });
        return false;
      }

      if (!data?.success) {
        toast({
          title: 'خطأ',
          description: data?.error || 'فشل في حذف المستخدم',
          variant: 'destructive',
        });
        return false;
      }

      // Log activity
      if (currentUser) {
        addActivityLog(
          'user_deleted',
          currentUser.id,
          profile?.full_name || currentUser.email || 'مستخدم',
          `تم حذف المستخدم: ${userName || 'مستخدم'}`,
          { deletedUserId: userId }
        );
      }

      toast({
        title: 'تم الحذف',
        description: 'تم حذف المستخدم بالكامل من النظام',
      });

      await fetchUsers();
      return true;
    } catch (error) {
      console.error('Error deleting user:', error);
      toast({
        title: 'خطأ',
        description: 'حدث خطأ أثناء حذف المستخدم',
        variant: 'destructive',
      });
      return false;
    }
  };

  // منح أو حجب صلاحية الاسترداد لكاشير (تُحفظ في user_roles.can_refund ويتحقق منها الخادم)
  const setUserRefundPermission = async (userId: string, allowed: boolean): Promise<boolean> => {
    try {
      const { data, error } = await supabase
        .from('user_roles')
        .update({ can_refund: allowed })
        .eq('user_id', userId)
        .select('user_id');
      if (error) throw error;
      if (!data || data.length === 0) throw new Error('لم يتم العثور على حساب الكاشير');
      setUsers(prev => prev.map(u => (u.user_id === userId ? { ...u, canRefund: allowed } : u)));
      toast({
        title: 'تم',
        description: allowed ? 'تم منح صلاحية الاسترداد' : 'تم حجب صلاحية الاسترداد',
      });
      return true;
    } catch (err) {
      console.error('Error updating refund permission:', err);
      toast({
        title: 'خطأ',
        description: 'تعذّر تحديث صلاحية الاسترداد',
        variant: 'destructive',
      });
      return false;
    }
  };

  return {
    users,
    isLoading,
    fetchUsers,
    addUser,
    updateUserRole,
    updateUserProfile,
    deleteUser,
    setUserRefundPermission,
  };
}
