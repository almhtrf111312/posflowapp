import { isAppOffline } from '@/hooks/use-network-status';
/**
 * Flow POS Pro - Fast Stale-While-Revalidate Settings Hook
 * ========================================================
 * Cache-First hook with 0ms synchronous local retrieval from localStorage.
 * Performs background non-blocking revalidation against Supabase cloud storage.
 * Eliminates UI loading spinners on navigation and settings screen opens.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  loadUnifiedStoreSettings,
  saveUnifiedStoreSettings,
  pullStoreSettingsWithGuard,
  UnifiedStoreSettings,
} from '@/lib/store-settings-sync';
import { subscribeToEvent, EVENTS } from '@/lib/events';

export interface UseFastSettingsResult {
  settings: UnifiedStoreSettings;
  isSyncing: boolean;
  updateSettings: (partial: Partial<UnifiedStoreSettings>) => Promise<boolean>;
  refreshFromCloud: () => Promise<UnifiedStoreSettings>;
}

export function useFastSettings(): UseFastSettingsResult {
  // 1. Synchronous initial render (0ms - Cache First)
  const [settings, setSettings] = useState<UnifiedStoreSettings>(() => loadUnifiedStoreSettings());
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const isMountedRef = useRef<boolean>(true);

  // 2. Listen to cross-tab / local event updates
  useEffect(() => {
    isMountedRef.current = true;

    const unsubscribe = subscribeToEvent(EVENTS.SETTINGS_UPDATED, () => {
      if (isMountedRef.current) {
        setSettings(loadUnifiedStoreSettings());
      }
    });

    return () => {
      isMountedRef.current = false;
      unsubscribe();
    };
  }, []);

  // 3. Quiet non-blocking background revalidation
  useEffect(() => {
    let cancelled = false;

    const revalidate = async () => {
      if (typeof navigator !== 'undefined' && isAppOffline()) return;
      setIsSyncing(true);
      try {
        const cloudSettings = await pullStoreSettingsWithGuard();
        if (!cancelled && isMountedRef.current && cloudSettings) {
          setSettings(cloudSettings);
        }
      } catch (err) {
        console.warn('[useFastSettings] Background revalidation failed silently:', err);
      } finally {
        if (!cancelled && isMountedRef.current) {
          setIsSyncing(false);
        }
      }
    };

    void revalidate();

    return () => {
      cancelled = true;
    };
  }, []);

  // 4. Instant local write followed by background cloud propagation
  const updateSettings = useCallback(async (partial: Partial<UnifiedStoreSettings>): Promise<boolean> => {
    // Immediate optimistic local update
    const nextSettings = { ...loadUnifiedStoreSettings(), ...partial };
    setSettings(nextSettings);

    try {
      const res = await saveUnifiedStoreSettings(partial, { waitCloud: false });
      return res.success;
    } catch (err) {
      console.warn('[useFastSettings] Error saving unified store settings:', err);
      return false;
    }
  }, []);

  // 5. Explicit manual refresh if requested
  const refreshFromCloud = useCallback(async (): Promise<UnifiedStoreSettings> => {
    setIsSyncing(true);
    try {
      const fresh = await pullStoreSettingsWithGuard();
      if (isMountedRef.current) {
        setSettings(fresh);
      }
      return fresh;
    } finally {
      if (isMountedRef.current) {
        setIsSyncing(false);
      }
    }
  }, []);

  return {
    settings,
    isSyncing,
    updateSettings,
    refreshFromCloud,
  };
}

export default useFastSettings;
