import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useUserRole, AppRole } from '@/hooks/user-role-context';
import { useAuth } from '@/hooks/auth-context';
import { Loader2 } from 'lucide-react';
import { isGuestDemoMode } from '@/lib/demo-data';

interface RoleGuardProps {
  children: ReactNode;
  allowedRoles: AppRole[];
  redirectTo?: string;
  fallback?: ReactNode;
  /** The page this guard protects (allowed_pages key). Needed for keep-alive tabs, which stay mounted while the user is on
   *  another route: without it the guard read the CURRENT route and could redirect the user away from an allowed page. */
  pageKey?: string;
}

// Map routes to page keys for allowed_pages check
const routeToPageKey: Record<string, string> = {
  '/dashboard': 'dashboard',
  '/products': 'products',
  '/partners': 'partners',
  '/reports': 'reports',
  '/purchases': 'purchases',
  '/expenses': 'expenses',
  '/customers': 'customers',
  '/invoices': 'invoices',
  '/services': 'services',
  '/warehouses': 'warehouses',
  '/stock-transfer': 'stock-transfer',
  '/settings': 'settings',
};

export function RoleGuard(props: RoleGuardProps) {
  // In Guest Demo Mode: grant full browsing access to all standard management pages
  // Only the Boss Panel (/boss) remains strictly restricted to real boss accounts
  // (hooks live in the inner component, so they are never conditional)
  if (isGuestDemoMode()) {
    if (props.allowedRoles.includes('admin') || props.allowedRoles.includes('cashier')) {
      return <>{props.children}</>;
    }
  }
  return <RoleGuardInner {...props} />;
}

function RoleGuardInner({
  children,
  allowedRoles,
  redirectTo = '/',
  fallback,
  pageKey: explicitPageKey,
}: RoleGuardProps) {

  const { role, isLoading } = useUserRole();
  const { profile } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!role || !allowedRoles.includes(role)) {
    // التحقق من صلاحيات الكاشير فقط إذا كان الدور كاشير صريح
    if (role === 'cashier' && profile) {
      const allowedPages = profile.allowed_pages;
      if (allowedPages && allowedPages.length > 0) {
        const currentPath = location.pathname;
        // Check exact match or prefix match for nested routes
        const pageKey = explicitPageKey || routeToPageKey[currentPath] ||
          Object.entries(routeToPageKey).find(([route]) => currentPath.startsWith(route))?.[1];
        if (pageKey && allowedPages.includes(pageKey)) {
          return <>{children}</>;
        }
      }
    }
    
    if (fallback !== undefined) {
      return <>{fallback}</>;
    }
    return <Navigate to={redirectTo} replace />;
  }

  return <>{children}</>;
}
