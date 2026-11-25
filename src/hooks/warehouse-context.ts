import { createContext, useContext } from 'react';
import { Warehouse } from '@/lib/cloud/warehouses-cloud';

export interface WarehouseContextType {
  warehouses: Warehouse[];
  activeWarehouse: Warehouse | null;
  mainWarehouse: Warehouse | null;
  isLoading: boolean;
  setActiveWarehouse: (warehouse: Warehouse | null) => void;
  refreshWarehouses: () => Promise<void>;
  ensureMainWarehouse: () => Promise<Warehouse | null>;
}
export const WarehouseContext = createContext<WarehouseContextType | undefined>(undefined);
export function useWarehouse() {
  const context = useContext(WarehouseContext);
  if (context === undefined) {
    throw new Error('useWarehouse must be used within a WarehouseProvider');
  }
  return context;
}
