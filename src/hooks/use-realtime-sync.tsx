// Realtime Sync Hook - Enables instant data synchronization across devices
import { useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './use-auth';
import { EVENTS, emitEvent } from '@/lib/events';
import { getOwnerIdForInsert } from '@/lib/supabase-store';
import { isGuestDemoMode } from '@/lib/demo-data';
import { pullStoreSettingsWithGuard } from '@/lib/store-settings-sync';
import { isLocalOnlyMode } from '@/lib/subscription-lock';

const SETTINGS_STORAGE_KEY = 'hyperpos_settings_v1';

// Unified tables list for easier management and consistent owner-scoping
const SYNC_TABLES = [
  { name: 'products', event: EVENTS.PRODUCTS_UPDATED },
  { name: 'categories', event: EVENTS.CATEGORIES_UPDATED },
  { name: 'invoices', event: EVENTS.INVOICES_UPDATED },
  { name: 'debts', event: EVENTS.DEBTS_UPDATED },
  { name: 'customers', event: EVENTS.CUSTOMERS_UPDATED },
  { name: 'partners', event: EVENTS.PARTNERS_UPDATED },
  { name: 'expenses', event: EVENTS.EXPENSES_UPDATED },
  { name: 'warehouses', event: EVENTS.WAREHOUSES_UPDATED },
  { name: 'stock_transfers', event: EVENTS.STOCK_TRANSFERS_UPDATED },
  { name: 'stock_movements', event: EVENTS.PRODUCTS_UPDATED },
  { name: 'purchase_invoices', event: EVENTS.PURCHASES_UPDATED },
  { name: 'maintenance_services', event: EVENTS.MAINTENANCE_UPDATED },
  { name: 'recurring_expenses', event: EVENTS.RECURRING_EXPENSES_UPDATED },
  { name: 'cash_shifts', event: EVENTS.CASH_SHIFTS_UPDATED },
  { name: 'shift_transactions', event: EVENTS.CASHBOX_UPDATED },
  { name: 'profit_records', event: EVENTS.PROFITS_UPDATED },
];

export function useRealtimeSync() {
  const { user } = useAuth();
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const debounceTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // ✅ تخميد وتجميع أحداث المزامنة الحية (Debounce & Batch Realtime)
  // يمنع إرسال أحداث متكررة أو تجميد الواجهة عند استلام عدة تعديلات متتالية على نفس الجدول
  const emitDebouncedEvent = (tableName: string, eventName: string) => {
    const existingTimer = debounceTimersRef.current.get(tableName);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      debounceTimersRef.current.delete(tableName);
      console.log(`[Realtime] Emitting targeted event for changed table: ${tableName}`);
      emitEvent(eventName);
    }, 350);

    debounceTimersRef.current.set(tableName, timer);
  };

  useEffect(() => {
    // In Guest Demo Mode, do not connect to Supabase realtime channels
    if (isGuestDemoMode() || isLocalOnlyMode()) {
      return;
    }

    if (!user) {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
      return;
    }

    let isMounted = true;

    const setupChannel = async () => {
      // ✅ Crucial: Get the correct ownerId (especially for cashiers)
      const ownerId = await getOwnerIdForInsert();
      
      if (!isMounted || !ownerId) return;

      console.log(`[Realtime] Initializing sync for owner: ${ownerId}`);

      // Cleanup existing channel if any
      if (channelRef.current) {
        try {
          supabase.removeChannel(channelRef.current);
        } catch (err) {
          console.warn('[Realtime] Error removing old channel:', err);
        }
        channelRef.current = null;
      }

      // Create realtime channel with unique timestamp to guarantee a pristine closed state
      const channelTopic = `owner-sync-${ownerId}-${Date.now()}`;
      const channel = supabase.channel(channelTopic);

      // Register all tables with the same owner-scoped filter and targeted debouncing
      SYNC_TABLES.forEach(table => {
        channel.on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: table.name,
          filter: `user_id=eq.${ownerId}`
        }, (payload) => {
          console.log(`[Realtime] ${table.name} changed (${payload.eventType})`);
          // ✅ تحديث الجدول الذي تغير فقط بهدوء مع تخميد التكرار السريع
          emitDebouncedEvent(table.name, table.event);
        });
      });

      // Special handling for store settings
      channel.on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'stores',
        filter: `user_id=eq.${ownerId}`
      }, async (payload) => {
        console.log('[Realtime] Store settings changed:', payload.eventType);
        if (isMounted) {
          try {
            await pullStoreSettingsWithGuard();
            console.log('[Realtime] Unified store settings updated & applied to runtime');
          } catch (e) {
            console.error('[Realtime] Failed to update local settings:', e);
          }
        }
      });

      channel.subscribe((status) => {
        console.log('[Realtime] Subscription status:', status);
        // ✅ فحص الإعدادات بهدوء في الخلفية دون مسح الكاش ودون إطلاق عواصف من الأحداث
        if (status === 'SUBSCRIBED') {
          pullStoreSettingsWithGuard().catch(() => {});
        }
      });

      channelRef.current = channel;
    };

    setupChannel();

    // فحص الإعدادات بهدوء عند عودة الاتصال دون مسح الكاشات
    const handleOnline = () => {
      pullStoreSettingsWithGuard().catch(() => {});
    };
    window.addEventListener('online', handleOnline);

    return () => {
      isMounted = false;
      window.removeEventListener('online', handleOnline);
      // إلغاء أي مؤقتات تخميد معلقة
      debounceTimersRef.current.forEach(timer => clearTimeout(timer));
      debounceTimersRef.current.clear();
      if (channelRef.current) {
        try {
          supabase.removeChannel(channelRef.current);
        } catch (err) {
          console.warn('[Realtime] Error removing channel on unmount:', err);
        }
        channelRef.current = null;
      }
    };
  }, [user?.id]);
}
