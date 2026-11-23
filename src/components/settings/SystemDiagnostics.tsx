import { isLocalDataMode } from '@/hooks/use-network-status';
import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { 
  AlertTriangle, 
  CheckCircle2, 
  XCircle, 
  Users, 
  Shield, 
  Key,
  RefreshCw,
  Loader2,
  AlertCircle,
  UserX,
  UserCheck,
  Clock,
  Trash2,
  Wrench
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast as sonnerToast } from '@/lib/sonner-bridge';
import { useLanguage } from '@/hooks/use-language';
import { format } from 'date-fns';
import { ar, enUS } from 'date-fns/locale';

interface DiagnosticUser {
  user_id: string;
  email: string;
  full_name: string | null;
  role: string | null;
  has_role: boolean;
  has_profile: boolean;
  has_license: boolean;
  license_expires: string | null;
  license_revoked: boolean;
  is_active: boolean;
  issues: string[];
}

interface DiagnosticStats {
  total_users: number;
  users_with_roles: number;
  users_without_roles: number;
  users_with_licenses: number;
  expired_licenses: number;
  revoked_licenses: number;
  active_admins: number;
  active_cashiers: number;
}

export function SystemDiagnostics() {
  const { language } = useLanguage();
  const isEn = language === 'en';
  const toast = ({ title, description, variant }: { title?: string; description?: string; variant?: 'destructive' | 'default' }) => {
    if (variant === 'destructive') sonnerToast.error(title || description || '', title && description ? { description } : undefined);
    else sonnerToast.success(title || description || '', title && description ? { description } : undefined);
  };
  const [isLoading, setIsLoading] = useState(true);
  const [users, setUsers] = useState<DiagnosticUser[]>([]);
  const [stats, setStats] = useState<DiagnosticStats | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [deleteTarget, setDeleteTarget] = useState<DiagnosticUser | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const fetchDiagnostics = async () => {
    // تشخيصات السحابة تحتاج إنترنت: لا ننتظر مهلة شبكة غير موجودة
    if (isLocalDataMode()) { setIsLoading(false); return; }
    setIsLoading(true);
    try {
      const { data: rolesData, error: rolesError } = await supabase
        .from('user_roles')
        .select('user_id, role, is_active, owner_id, created_at');
      if (rolesError) throw rolesError;

      const { data: profilesData, error: profilesError } = await supabase
        .from('profiles')
        .select('user_id, full_name');
      if (profilesError) throw profilesError;

      const { data: licensesData, error: licensesError } = await supabase
        .from('app_licenses')
        .select('user_id, expires_at, is_revoked, is_trial, license_tier');
      if (licensesError) throw licensesError;

      const userIds = rolesData?.map(r => r.user_id) || [];
      let emailMap: Record<string, string> = {};
      
      if (userIds.length > 0) {
        try {
          const { data: emailsData, error: emailsError } = await supabase.functions.invoke('get-users-emails', {
            body: { userIds },
          });
          if (!emailsError && emailsData?.emails) {
            emailMap = emailsData.emails;
          }
        } catch (e) {
          console.error('Error fetching user emails:', e);
        }
      }

      const diagnosticUsers: DiagnosticUser[] = [];
      const now = new Date();

      const roleUserIds = new Set(rolesData?.map(r => r.user_id) || []);
      const profileUserIds = new Set(profilesData?.map(p => p.user_id) || []);
      const licenseUserIds = new Set(licensesData?.map(l => l.user_id) || []);
      const allUserIds = new Set([...roleUserIds, ...profileUserIds, ...licenseUserIds]);

      for (const userId of allUserIds) {
        const role = rolesData?.find(r => r.user_id === userId);
        const profile = profilesData?.find(p => p.user_id === userId);
        const license = licensesData?.find(l => l.user_id === userId);
        
        const issues: string[] = [];
        
        if (!role) issues.push(isEn ? 'Missing Role' : 'دور مفقود');
        if (!profile) issues.push(isEn ? 'Missing Profile' : 'ملف شخصي مفقود');
        
        if (role?.role === 'admin' || role?.role === 'boss') {
          if (!license) {
            issues.push(isEn ? 'Missing License' : 'ترخيص مفقود');
          } else {
            if (new Date(license.expires_at) < now) issues.push(isEn ? 'Expired License' : 'ترخيص منتهي');
            if (license.is_revoked) issues.push(isEn ? 'Revoked License' : 'ترخيص ملغى');
          }
        }
        
        if (role && !role.is_active) issues.push(isEn ? 'Inactive Role' : 'دور غير نشط');

        diagnosticUsers.push({
          user_id: userId,
          email: emailMap[userId] || (isEn ? 'Unknown' : 'غير معروف'),
          full_name: profile?.full_name || null,
          role: role?.role || null,
          has_role: !!role,
          has_profile: !!profile,
          has_license: !!license,
          license_expires: license?.expires_at || null,
          license_revoked: license?.is_revoked || false,
          is_active: role?.is_active ?? false,
          issues,
        });
      }

      diagnosticUsers.sort((a, b) => {
        if (a.issues.length !== b.issues.length) return b.issues.length - a.issues.length;
        const roleOrder = { boss: 0, admin: 1, cashier: 2 };
        return (roleOrder[a.role as keyof typeof roleOrder] ?? 3) - (roleOrder[b.role as keyof typeof roleOrder] ?? 3);
      });

      const statsData: DiagnosticStats = {
        total_users: allUserIds.size,
        users_with_roles: roleUserIds.size,
        users_without_roles: allUserIds.size - roleUserIds.size,
        users_with_licenses: licenseUserIds.size,
        expired_licenses: licensesData?.filter(l => new Date(l.expires_at) < now).length || 0,
        revoked_licenses: licensesData?.filter(l => l.is_revoked).length || 0,
        active_admins: rolesData?.filter(r => r.role === 'admin' && r.is_active).length || 0,
        active_cashiers: rolesData?.filter(r => r.role === 'cashier' && r.is_active).length || 0,
      };

      setUsers(diagnosticUsers);
      setStats(statsData);
      setLastRefresh(new Date());
    } catch (error) {
      console.error('Error fetching diagnostics:', error);
      toast({ title: isEn ? 'Error' : 'خطأ', description: isEn ? 'Failed to fetch diagnostic data' : 'فشل في جلب بيانات التشخيص', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { fetchDiagnostics(); }, []);

  const handleDeleteUser = async (user: DiagnosticUser) => {
    setIsDeleting(true);
    try {
      const deleteType = user.role === 'admin' ? 'owner' : user.role === 'boss' ? 'boss' : 'user';
      const { data, error } = await supabase.functions.invoke('delete-user', {
        body: { userId: user.user_id, deleteType },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      toast({ title: isEn ? 'Deleted' : 'تم الحذف', description: isEn ? `Account "${user.full_name || user.email}" deleted successfully` : `تم حذف الحساب "${user.full_name || user.email}" بنجاح` });
      setDeleteTarget(null);
      fetchDiagnostics();
    } catch (error: any) {
      console.error('Delete user error:', error);
      toast({ title: isEn ? 'Error' : 'خطأ', description: error.message || (isEn ? 'Failed to delete account' : 'فشل في حذف الحساب'), variant: 'destructive' });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleCreateProfile = async (userId: string) => {
    try {
      const { error } = await supabase.from('profiles').insert({ user_id: userId, full_name: isEn ? 'New User' : 'مستخدم جديد' });
      if (error) throw error;
      toast({ title: isEn ? 'Done' : 'تم', description: isEn ? 'Profile created' : 'تم إنشاء الملف الشخصي' });
      fetchDiagnostics();
    } catch (error: any) {
      toast({ title: isEn ? 'Error' : 'خطأ', description: error.message || (isEn ? 'Failed to create profile' : 'فشل في إنشاء الملف الشخصي'), variant: 'destructive' });
    }
  };

  const usersWithIssues = users.filter(u => u.issues.length > 0);
  const healthyUsers = users.filter(u => u.issues.length === 0);

  const getRoleBadge = (role: string | null) => {
    switch (role) {
      case 'boss': return <Badge variant="outline" className="bg-warning/15 text-warning border-warning/30">{isEn ? 'Boss' : 'بوس'}</Badge>;
      case 'admin': return <Badge variant="outline" className="bg-info/15 text-info border-info/30">{isEn ? 'Admin' : 'مدير'}</Badge>;
      case 'cashier': return <Badge variant="outline" className="bg-success/15 text-success border-success/30">{isEn ? 'Cashier' : 'كاشير'}</Badge>;
      default: return <Badge variant="destructive">{isEn ? 'No Role' : 'بدون دور'}</Badge>;
    }
  };

  const getStatusIcon = (user: DiagnosticUser) => {
    if (user.issues.length === 0) return <CheckCircle2 className="w-5 h-5 text-success" />;
    if (user.issues.some(i => i.includes('مفقود') || i.includes('Missing'))) return <XCircle className="w-5 h-5 text-destructive" />;
    return <AlertTriangle className="w-5 h-5 text-warning" />;
  };

  const getActionButtons = (user: DiagnosticUser) => {
    const buttons: React.ReactNode[] = [];

    if (!user.has_profile && user.has_role) {
      buttons.push(
        <Button key="profile" size="sm" variant="outline" className="text-xs gap-1" onClick={() => handleCreateProfile(user.user_id)}>
          <Wrench className="w-3 h-3" /> {isEn ? "Create Profile" : "إنشاء ملف"}
        </Button>
      );
    }

    // Always allow delete for problematic accounts (orphans, missing role, etc.)
    if (user.role !== 'boss') {
      buttons.push(
        <Button key="delete" size="sm" variant="destructive" className="text-xs gap-1" onClick={() => setDeleteTarget(user)}>
          <Trash2 className="w-3 h-3" /> {isEn ? "Delete Account" : "حذف الحساب"}
        </Button>
      );
    }

    return buttons.length > 0 ? <div className="flex flex-wrap gap-1">{buttons}</div> : <span className="text-muted-foreground text-xs">-</span>;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <span className="ms-2 text-muted-foreground">{isEn ? "Loading diagnostic data..." : "جاري تحميل بيانات التشخيص..."}</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base sm:text-lg font-bold text-foreground tracking-tight flex items-center gap-2">
            <Shield className="w-4 h-4 text-primary shrink-0" />
            {isEn ? "System Diagnostics" : "تشخيص النظام"}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {isEn ? 'Last updated:' : 'آخر تحديث:'} {format(lastRefresh, 'PPpp', { locale: isEn ? enUS : ar })}
          </p>
        </div>
        <Button onClick={fetchDiagnostics} variant="outline" disabled={isLoading}>
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          {isEn ? "Refresh" : "تحديث"}
        </Button>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-info/15 flex items-center justify-center">
                  <Users className="w-5 h-5 text-info" />
                </div>
                <div>
                  <p className="text-2xl font-bold tabular-nums">{stats.total_users}</p>
                  <p className="text-xs text-muted-foreground">{isEn ? "Total Users" : "إجمالي المستخدمين"}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-success/15 flex items-center justify-center">
                  <UserCheck className="w-5 h-5 text-success" />
                </div>
                <div>
                  <p className="text-2xl font-bold tabular-nums">{stats.users_with_roles}</p>
                  <p className="text-xs text-muted-foreground">{isEn ? "With Roles" : "لديهم أدوار"}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${stats.users_without_roles > 0 ? 'bg-destructive/15' : 'bg-muted'}`}>
                  <UserX className={`w-5 h-5 ${stats.users_without_roles > 0 ? 'text-destructive' : 'text-muted-foreground'}`} />
                </div>
                <div>
                  <p className={`text-2xl font-bold tabular-nums ${stats.users_without_roles > 0 ? 'text-destructive' : ''}`}>
                    {stats.users_without_roles}
                  </p>
                  <p className="text-xs text-muted-foreground">{isEn ? "Without Roles" : "بدون أدوار"}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${stats.expired_licenses > 0 ? 'bg-warning/15' : 'bg-muted'}`}>
                  <Clock className={`w-5 h-5 ${stats.expired_licenses > 0 ? 'text-warning' : 'text-muted-foreground'}`} />
                </div>
                <div>
                  <p className={`text-2xl font-bold tabular-nums ${stats.expired_licenses > 0 ? 'text-warning' : ''}`}>
                    {stats.expired_licenses}
                  </p>
                  <p className="text-xs text-muted-foreground">{isEn ? "Expired Licenses" : "تراخيص منتهية"}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Issues Alert */}
      {usersWithIssues.length > 0 && (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-destructive flex items-center gap-2">
              <AlertCircle className="w-5 h-5" />
              {isEn ? `Users with Issues (${usersWithIssues.length})` : `مستخدمين لديهم مشاكل (${usersWithIssues.length})`}
            </CardTitle>
            <CardDescription>
              {isEn ? "These users have issues that need to be fixed" : "هؤلاء المستخدمين لديهم مشاكل تحتاج إلى إصلاح"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-start">{isEn ? "Status" : "الحالة"}</TableHead>
                  <TableHead className="text-start">{isEn ? "User" : "المستخدم"}</TableHead>
                  <TableHead className="text-start">{isEn ? "Email" : "البريد"}</TableHead>
                  <TableHead className="text-start">{isEn ? "Role" : "الدور"}</TableHead>
                  <TableHead className="text-start">{isEn ? "Issues" : "المشاكل"}</TableHead>
                  <TableHead className="text-center">{isEn ? "Actions" : "إجراءات"}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usersWithIssues.map((user) => (
                  <TableRow key={user.user_id}>
                    <TableCell>{getStatusIcon(user)}</TableCell>
                    <TableCell className="font-medium">
                      {user.full_name || (isEn ? 'Unnamed' : 'بدون اسم')}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm font-mono">
                      {user.email}
                    </TableCell>
                    <TableCell>{getRoleBadge(user.role)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {user.issues.map((issue, idx) => (
                          <Badge key={idx} variant="destructive" className="text-xs">
                            {issue}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>{getActionButtons(user)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Healthy Users */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-green-500" />
            {isEn ? `Users without Issues (${healthyUsers.length})` : `مستخدمين بدون مشاكل (${healthyUsers.length})`}
          </CardTitle>
          <CardDescription>
            {isEn ? "All of these users have valid configurations" : "جميع هؤلاء المستخدمين لديهم إعدادات صحيحة"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {healthyUsers.length === 0 ? (
            <p className="text-muted-foreground text-center py-4">{isEn ? "No users found" : "لا يوجد مستخدمين"}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-start">{isEn ? "Status" : "الحالة"}</TableHead>
                  <TableHead className="text-start">{isEn ? "User" : "المستخدم"}</TableHead>
                  <TableHead className="text-start">{isEn ? "Email" : "البريد"}</TableHead>
                  <TableHead className="text-start">{isEn ? "Role" : "الدور"}</TableHead>
                  <TableHead className="text-start">{isEn ? "License Expiry" : "انتهاء الترخيص"}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {healthyUsers.map((user) => (
                  <TableRow key={user.user_id}>
                    <TableCell>{getStatusIcon(user)}</TableCell>
                    <TableCell className="font-medium">
                      {user.full_name || (isEn ? 'Unnamed' : 'بدون اسم')}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm font-mono">
                      {user.email}
                    </TableCell>
                    <TableCell>{getRoleBadge(user.role)}</TableCell>
                    <TableCell>
                      {user.license_expires ? (
                        <span className={`text-sm ${
                          new Date(user.license_expires) < new Date() 
                            ? 'text-red-500' 
                            : 'text-green-500'
                        }`}>
                          {format(new Date(user.license_expires), 'yyyy/MM/dd', { locale: ar })}
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-sm">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* System Summary */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="w-5 h-5 text-primary" />
            {isEn ? "License Summary" : "ملخص التراخيص"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div className="p-4 bg-muted rounded-lg">
              <p className="text-sm text-muted-foreground">{isEn ? "Active Licenses" : "تراخيص نشطة"}</p>
              <p className="text-2xl font-bold text-green-500">{stats?.users_with_licenses || 0}</p>
            </div>
            <div className="p-4 bg-muted rounded-lg">
              <p className="text-sm text-muted-foreground">{isEn ? "Expired Licenses" : "تراخيص منتهية"}</p>
              <p className={`text-2xl font-bold ${(stats?.expired_licenses || 0) > 0 ? 'text-yellow-500' : ''}`}>
                {stats?.expired_licenses || 0}
              </p>
            </div>
            <div className="p-4 bg-muted rounded-lg">
              <p className="text-sm text-muted-foreground">{isEn ? "Revoked Licenses" : "تراخيص ملغاة"}</p>
              <p className={`text-2xl font-bold ${(stats?.revoked_licenses || 0) > 0 ? 'text-red-500' : ''}`}>
                {stats?.revoked_licenses || 0}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isEn ? "Confirm Account Deletion" : "تأكيد حذف الحساب"}</AlertDialogTitle>
            <AlertDialogDescription>
              {isEn ? (<>Are you sure you want to permanently delete <strong>{deleteTarget?.full_name || deleteTarget?.email}</strong>?</>) : (<>هل أنت متأكد من حذف حساب <strong>{deleteTarget?.full_name || deleteTarget?.email}</strong> نهائياً؟</>)}
              <br />
              {isEn ? "All data associated with this account will be deleted and this action cannot be undone." : "سيتم حذف جميع البيانات المرتبطة بهذا الحساب ولا يمكن التراجع عن هذا الإجراء."}
              {deleteTarget?.role === 'admin' && (
                <span className="block mt-2 text-destructive font-medium">
                  {isEn ? "⚠️ This is an Admin account — all associated sub-accounts will also be deleted!" : "⚠️ هذا حساب مدير - سيتم حذف جميع الحسابات التابعة له أيضاً!"}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>{isEn ? "Cancel" : "إلغاء"}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={isDeleting}
              onClick={(e) => {
                e.preventDefault();
                if (deleteTarget) handleDeleteUser(deleteTarget);
              }}
            >
              {isDeleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              {isEn ? "Delete Permanently" : "حذف نهائي"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
