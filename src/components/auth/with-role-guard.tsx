import { RoleGuard } from '@/components/auth/RoleGuard';
import type { AppRole } from '@/hooks/use-user-role';

// HOC for pages that require specific roles
export function withRoleGuard<P extends object>(
  Component: React.ComponentType<P>,
  allowedRoles: AppRole[],
  redirectTo?: string
) {
  return function GuardedComponent(props: P) {
    return (
      <RoleGuard allowedRoles={allowedRoles} redirectTo={redirectTo}>
        <Component {...props} />
      </RoleGuard>
    );
  };
}
