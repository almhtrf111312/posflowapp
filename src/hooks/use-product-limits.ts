import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useLicense } from '@/hooks/use-license';
import { loadProductsCloud } from '@/lib/cloud/products-cloud';

export interface ProductLimitStatus {
  canAdd: boolean;
  canAddWithImage: boolean;
  currentCount: number;
  maxProducts: number;
  tier: 'trial' | 'standard' | 'pro' | 'institution';
  reason?: string;
  loading: boolean;
}

export function useProductLimits() {
  const { user } = useAuth();
  const license = useLicense();
  const licenseState = (license as any)?.licenseState || license;

  const [status, setStatus] = useState<ProductLimitStatus>({
    canAdd: true,
    canAddWithImage: true,
    currentCount: 0,
    maxProducts: 100,
    tier: 'trial',
    loading: true,
  });

  const checkLimits = useCallback(async () => {
    if (!user) {
      setStatus(prev => ({ ...prev, loading: false }));
      return;
    }
    try {
      // 1. حساب عدد المنتجات الحالية من السحابة أو المحلي كاحتياطي
      let currentCount = 0;
      try {
        const { count, error } = await supabase
          .from('products')
          .select('*', { count: 'exact', head: true });

        if (error) throw error;
        currentCount = count || 0;
      } catch {
        // احتياطي عند انقطاع الاتصال: احتساب المنتجات محلياً
        const localProducts = await loadProductsCloud().catch(() => []);
        currentCount = localProducts.length;
      }

      // 2. قراءة باقة الترخيص
      const isTrial = !!licenseState?.isTrial;
      const tierName: 'trial' | 'standard' | 'pro' | 'institution' =
        (licenseState as any)?.planAudience ||
        (licenseState as any)?.licenseTier ||
        (isTrial ? 'trial' : 'standard');

      // قراءة الحد الأقصى الفعلي المسجل لترخيص هذا المتجر بدقة
      const dynamicLimit = Number(licenseState?.maxProducts ?? (licenseState as any)?.max_products);
      let maxProducts = 100;
      if (dynamicLimit > 0) {
        maxProducts = dynamicLimit;
      } else if (tierName === 'institution') {
        maxProducts = 5000;
      } else if (tierName === 'pro') {
        maxProducts = 1000;
      } else if (tierName === 'standard') {
        maxProducts = 600;
      } else {
        maxProducts = 100;
      }

      const canAdd = currentCount < maxProducts;
      // شرط باقة Pro: فوق 600 منتج بدون صور
      const canAddWithImage = tierName === 'pro' && currentCount >= 600 ? false : canAdd;

      setStatus({
        canAdd,
        canAddWithImage,
        currentCount,
        maxProducts,
        tier: tierName,
        loading: false,
      });
    } catch (e) {
      console.error('Failed to evaluate product limits:', e);
      setStatus(prev => ({ ...prev, loading: false }));
    }
  }, [user, licenseState]);

  useEffect(() => {
    checkLimits();
  }, [checkLimits]);

  return { ...status, refreshLimits: checkLimits };
}
