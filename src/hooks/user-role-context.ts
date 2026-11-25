import { createContext, useContext } from 'react';
import { secureSet, secureGet } from '@/lib/secure-storage';
import { isGuestDemoMode } from '@/lib/demo-data';

export type AppRole = 'boss' | 'admin' | 'cashier';
export interface UserRoleState {
  role: AppRole | null;
  ownerId: string | null;
  isLoading: boolean;
  isBoss: boolean;
  isAdmin: boolean;
  isCashier: boolean;
  isOwner: boolean;
  canAccessSettings: boolean;
  canAccessReports: boolean;
  canAccessPartners: boolean;
  canManageLicenses: boolean;
  canManageUsers: boolean;
  canEditPrice: boolean;
}
export interface UserRoleContextType extends UserRoleState {
  refreshRole: () => Promise<void>;
}
export const UserRoleContext = createContext<UserRoleContextType | undefined>(undefined);
// Encrypted storage key — data is XOR-encrypted with device key via secure-storage
export const ROLE_CACHE_KEY = 'user_role_cache';
export const ROLE_NS = 'hp_rc';
 // short namespace to avoid plain-text key exposure
export const ROLE_QUERY_TIMEOUT_MS = 8000;
export const RETRY_DELAYS_MS = [2000, 5000, 10000];
export const EMPTY_ROLE_STATE: UserRoleState = {
  role: null,
  ownerId: null,
  isLoading: false,
  isBoss: false,
  isAdmin: false,
  isCashier: false,
  isOwner: false,
  canAccessSettings: false,
  canAccessReports: false,
  canAccessPartners: false,
  canManageLicenses: false,
  canManageUsers: false,
  canEditPrice: false,
};
export function buildStateFromRole(role: AppRole, ownerId: string, isDemo = false): UserRoleState {
  const isBoss = role === 'boss';
  const isAdmin = role === 'admin';
  const isCashier = role === 'cashier';
  const demoActive = isDemo || (typeof window !== 'undefined' && isGuestDemoMode());
  return {
    role,
    ownerId,
    isLoading: false,
    isBoss,
    isAdmin,
    isCashier,
    isOwner: isAdmin || isBoss,
    canAccessSettings: isBoss || isAdmin,
    canAccessReports: isBoss || isAdmin,
    canAccessPartners: isBoss || isAdmin,
    canManageLicenses: !demoActive && isBoss,
    canManageUsers: !demoActive && (isBoss || isAdmin),
    canEditPrice: isBoss || isAdmin,
  };
}
export function getCachedRole(userId: string): { role: AppRole; ownerId: string } | null {
  try {
    // Remove any legacy plain-text entry
    localStorage.removeItem('posflow_user_role_cache');

    const parsed = secureGet<{ userId: string; role: AppRole; ownerId: string }>(
      ROLE_CACHE_KEY,
      { namespace: ROLE_NS }
    );
    if (parsed && parsed.userId === userId && parsed.role) {
      return { role: parsed.role, ownerId: parsed.ownerId || userId };
    }
  } catch { /* ignore */ }
  return null;
}
export function setCachedRole(userId: string, role: AppRole, ownerId: string) {
  try {
    secureSet(ROLE_CACHE_KEY, { userId, role, ownerId }, { namespace: ROLE_NS });
  } catch { /* ignore */ }
}
export function useUserRole() {
  const context = useContext(UserRoleContext);
  if (context === undefined) {
    throw new Error('useUserRole must be used within a UserRoleProvider');
  }

  // In Guest Demo Mode, guarantee admin privileges locally for smooth navigation
  if (typeof window !== 'undefined' && isGuestDemoMode()) {
    if (!context.role || context.role !== 'admin') {
      return {
        ...context,
        role: 'admin' as AppRole,
        ownerId: 'guest-demo-user',
        isLoading: false,
        isBoss: false,
        isAdmin: true,
        isCashier: false,
        isOwner: true,
        canAccessSettings: true,
        canAccessReports: true,
        canAccessPartners: true,
        canManageLicenses: false,
        canManageUsers: false,
        canEditPrice: true,
      };
    }
  }

  return context;
}
