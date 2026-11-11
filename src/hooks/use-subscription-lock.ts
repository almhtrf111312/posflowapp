import { useLicense } from '@/hooks/use-license';

/** true عندما يكون المستخدم في وضع التجربة (غير مشترك). المدير العام مستثنى. */
export function useSubscriptionLocked(): boolean {
  const { isTrial, role, isLoading } = useLicense();
  return !isLoading && !!isTrial && role !== 'boss';
}
