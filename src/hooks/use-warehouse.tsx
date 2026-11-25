import { useState, useEffect, useCallback, ReactNode } from 'react';
import { useAuth } from './auth-context';
import { useUserRole } from './user-role-context';
import { Warehouse, loadWarehousesCloud, getMainWarehouseCloud, getWarehouseForCashierCloud, addWarehouseCloud, invalidateWarehousesCache } from '@/lib/cloud/warehouses-cloud';
import { subscribeToEvent, EVENTS } from '@/lib/events';
import { WarehouseContext } from '@/hooks/warehouse-context';

export function WarehouseProvider({ children }: { children: ReactNode }) {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [activeWarehouse, setActiveWarehouse] = useState<Warehouse | null>(null);
  const [mainWarehouse, setMainWarehouse] = useState<Warehouse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  
  const { user } = useAuth();
  const { isCashier, isAdmin, isBoss } = useUserRole();

  const loadData = useCallback(async () => {
    if (!user) {
      setWarehouses([]);
      setActiveWarehouse(null);
      setMainWarehouse(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      const allWarehouses = await loadWarehousesCloud();
      setWarehouses(allWarehouses);

      // Set main warehouse
      const main = await getMainWarehouseCloud();
      setMainWarehouse(main);

      // Set active warehouse based on role
      if (isCashier && user.id) {
        // Cashiers see their assigned warehouse
        const cashierWarehouse = await getWarehouseForCashierCloud(user.id);
        setActiveWarehouse(cashierWarehouse || main);
      } else {
        // Admins/Boss default to main warehouse
        setActiveWarehouse(main);
      }
    } catch (error) {
      console.error('[useWarehouse] Load error:', error);
    } finally {
      setIsLoading(false);
    }
  }, [user, isCashier]);

  // Ensure main warehouse exists (create if not)
  const ensureMainWarehouse = useCallback(async (): Promise<Warehouse | null> => {
    // Check local state first
    if (mainWarehouse) return mainWarehouse;

    // Check database directly (bypass cache) to prevent duplicates
    invalidateWarehousesCache();
    const existingWarehouses = await loadWarehousesCloud();
    const existingMain = existingWarehouses.find(w => w.type === 'main');
    
    if (existingMain) {
      setMainWarehouse(existingMain);
      return existingMain; // Already exists, no need to create
    }

    // Create main warehouse only if none exists
    const newWarehouse = await addWarehouseCloud({
      name: 'المستودع الرئيسي',
      type: 'main',
      assigned_cashier_id: null,
      address: null,
      phone: null,
      is_default: true,
      is_active: true
    });

    if (newWarehouse) {
      invalidateWarehousesCache();
      await loadData();
      return newWarehouse;
    }

    return null;
  }, [mainWarehouse, loadData]);

  const refreshWarehouses = useCallback(async () => {
    invalidateWarehousesCache();
    await loadData();
  }, [loadData]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Subscribe to warehouse updates
  useEffect(() => {
    const unsubscribe = subscribeToEvent(EVENTS.WAREHOUSES_UPDATED, () => {
      loadData();
    });

    return () => unsubscribe();
  }, [loadData]);

  return (
    <WarehouseContext.Provider value={{
      warehouses,
      activeWarehouse,
      mainWarehouse,
      isLoading,
      setActiveWarehouse,
      refreshWarehouses,
      ensureMainWarehouse
    }}>
      {children}
    </WarehouseContext.Provider>
  );
}
