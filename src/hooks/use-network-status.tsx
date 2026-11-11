// Network status: one shared monitor that verifies REAL internet access.
// A device can report "connected" (Wi-Fi / VPN / cellular interface is up) while the
// uplink is dead. That state is treated as OFFLINE here: the interface flag alone is never trusted.
import { useState, useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { Network } from '@capacitor/network';

const PROBE_CACHE_TTL = 4000; // positive cache (ms)
const NEGATIVE_PROBE_CACHE_TTL = 1500; // negative cache for fast recovery (ms)
const ONLINE_CHECK_INTERVAL_MS = 30_000; // re-verify while online to catch a silently dropped uplink
const OFFLINE_CHECK_INTERVAL_MS = 10_000; // re-verify while offline to catch recovery
const RETRY_BEFORE_OFFLINE_MS = 1500; // one retry so a slow link does not flap to offline

interface ProbeResult { isOnline: boolean; timestamp: number }
let globalProbeResult: ProbeResult | null = null;

/** Verified state produced by the monitor. Only flips after a failed probe AND a failed retry. */
let verifiedOffline = false;
const listeners = new Set<(offline: boolean) => void>();

function publishVerifiedState(offline: boolean) {
  if (offline === verifiedOffline) return;
  verifiedOffline = offline;
  listeners.forEach((listener) => listener(offline));
}

/**
 * Synchronous gate used by data layers: true when the device reports no interface,
 * or when the monitor has verified that the internet is unreachable.
 */
export function isAppOffline(): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  return verifiedOffline;
}

/** Helper kept for existing callers. */
export function isNetworkOnline(): boolean {
  return !isAppOffline();
}

/**
 * Async check for the Capacitor/browser interface flag.
 * Kept for callers that need the raw interface state.
 */
export async function getNetworkStatus(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return false;
  }
  if (Capacitor.isNativePlatform()) {
    try {
      const status = await Network.getStatus();
      return status.connected;
    } catch (error) {
      console.error('[Network] Failed to get status:', error);
      return typeof navigator !== 'undefined' ? navigator.onLine : true;
    }
  }
  return typeof navigator !== 'undefined' ? navigator.onLine : true;
}

/**
 * فحص فعلي للإنترنت عبر عدة مسارات متوازية (خادم التطبيق أولاً).
 * أي استجابة من أحد المسارات تعني اتصالاً حقيقياً؛ وفشل الكل يعني لا يوجد إنترنت.
 * @param timeoutMs مهلة الفحص بالمللي ثانية
 * @param opts.bypassCache تجاهل الكاش اللحظي (يُستخدم عند إعادة التحقق بعد فشل)
 */
export async function checkRealInternetAccess(
  timeoutMs: number = 6000,
  opts?: { bypassCache?: boolean },
): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    globalProbeResult = { isOnline: false, timestamp: Date.now() };
    return false;
  }

  if (!opts?.bypassCache && globalProbeResult) {
    const ttl = globalProbeResult.isOnline ? PROBE_CACHE_TTL : NEGATIVE_PROBE_CACHE_TTL;
    if (Date.now() - globalProbeResult.timestamp < ttl) {
      return globalProbeResult.isOnline;
    }
  }

  const interfaceUp = await getNetworkStatus();
  if (!interfaceUp) {
    globalProbeResult = { isOnline: false, timestamp: Date.now() };
    return false;
  }

  const effectiveTimeout = Math.max(timeoutMs, 4000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);

  const fetchProbe = (url: string) =>
    fetch(url, { method: 'GET', mode: 'no-cors', cache: 'no-store', signal: controller.signal }).then(() => true);

  const probes: Promise<unknown>[] = [];
  const backendUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

  if (backendUrl) {
    // أي استجابة HTTP من خادم التطبيق دليل قاطع على وصول فعلي للإنترنت
    probes.push(
      fetch(`${backendUrl}/auth/v1/health`, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
        headers: anonKey ? { apikey: anonKey } : undefined,
      }).then((res) => {
        if (res.status >= 200 && res.status < 600) return true;
        throw new Error(`HTTP ${res.status}`);
      }),
    );
  }

  probes.push(
    fetchProbe('https://1.1.1.1/cdn-cgi/trace'),
    fetchProbe('https://msftconnecttest.com/connecttest.txt'),
    fetchProbe('https://captive.apple.com/hotspot-detect.html'),
  );

  try {
    await (Promise as unknown as { any: <T>(p: Promise<T>[]) => Promise<T> }).any(probes);
    clearTimeout(timer);
    globalProbeResult = { isOnline: true, timestamp: Date.now() };
    return true;
  } catch {
    clearTimeout(timer);
    console.warn(`[Network] No internet reachable within ${effectiveTimeout}ms (interface may be up without uplink).`);
    globalProbeResult = { isOnline: false, timestamp: Date.now() };
    return false;
  }
}

// ---------- Shared monitor (ref-counted: runs once for the whole app) ----------

let monitorRefCount = 0;
let monitorTimer: ReturnType<typeof setTimeout> | null = null;
let monitorTeardown: (() => void) | null = null;
let checkInFlight: Promise<void> | null = null;

async function runConnectivityCheck(): Promise<void> {
  if (checkInFlight) return checkInFlight;
  checkInFlight = (async () => {
    try {
      let reachable = await checkRealInternetAccess(5000, { bypassCache: true });
      if (!reachable) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_BEFORE_OFFLINE_MS));
        reachable = await checkRealInternetAccess(5000, { bypassCache: true });
      }
      publishVerifiedState(!reachable);
    } finally {
      checkInFlight = null;
    }
  })();
  return checkInFlight;
}

function scheduleNextCheck() {
  if (monitorRefCount === 0) return;
  if (monitorTimer) clearTimeout(monitorTimer);
  const interval = verifiedOffline ? OFFLINE_CHECK_INTERVAL_MS : ONLINE_CHECK_INTERVAL_MS;
  monitorTimer = setTimeout(async () => {
    await runConnectivityCheck();
    scheduleNextCheck();
  }, interval);
}

async function checkNowAndReschedule() {
  await runConnectivityCheck();
  scheduleNextCheck();
}

function startMonitor() {
  monitorRefCount += 1;
  if (monitorRefCount > 1) return;

  const handleBrowserOnline = () => { void checkNowAndReschedule(); };
  const handleBrowserOffline = () => {
    publishVerifiedState(true);
    scheduleNextCheck();
  };
  const handleVisibility = () => {
    if (document.visibilityState === 'visible') void checkNowAndReschedule();
  };

  window.addEventListener('online', handleBrowserOnline);
  window.addEventListener('offline', handleBrowserOffline);
  document.addEventListener('visibilitychange', handleVisibility);

  let nativeHandle: { remove: () => Promise<void> | void } | null = null;
  let nativeRemoved = false;
  if (Capacitor.isNativePlatform()) {
    Network.addListener('networkStatusChange', (status) => {
      if (status.connected) {
        void checkNowAndReschedule();
      } else {
        publishVerifiedState(true);
        scheduleNextCheck();
      }
    }).then((handle) => {
      if (nativeRemoved) void handle.remove();
      else nativeHandle = handle;
    }).catch(() => {});
  }

  monitorTeardown = () => {
    window.removeEventListener('online', handleBrowserOnline);
    window.removeEventListener('offline', handleBrowserOffline);
    document.removeEventListener('visibilitychange', handleVisibility);
    nativeRemoved = true;
    if (nativeHandle) void nativeHandle.remove();
  };

  void checkNowAndReschedule();
}

function stopMonitor() {
  monitorRefCount = Math.max(0, monitorRefCount - 1);
  if (monitorRefCount > 0) return;
  if (monitorTimer) clearTimeout(monitorTimer);
  monitorTimer = null;
  if (monitorTeardown) monitorTeardown();
  monitorTeardown = null;
}

export interface NetworkStatus {
  isOnline: boolean;
  wasOffline: boolean;
  lastOnlineTime: number | null;
}

/**
 * Tracks verified connectivity for the UI and sync.
 * `onReconnect` fires once each time the verified state goes from offline to online.
 */
export function useNetworkStatus(onReconnect?: () => void) {
  const [status, setStatus] = useState<NetworkStatus>(() => {
    const online = !isAppOffline();
    return { isOnline: online, wasOffline: !online, lastOnlineTime: online ? Date.now() : null };
  });

  const onReconnectRef = useRef(onReconnect);
  useEffect(() => {
    onReconnectRef.current = onReconnect;
  }, [onReconnect]);

  useEffect(() => {
    let active = true;
    const listener = (offline: boolean) => {
      if (!active) return;
      if (offline) {
        setStatus((prev) => ({ ...prev, isOnline: false, wasOffline: true }));
        return;
      }
      setStatus({ isOnline: true, wasOffline: false, lastOnlineTime: Date.now() });
      setTimeout(() => onReconnectRef.current?.(), 300);
    };
    listeners.add(listener);
    startMonitor();
    // Sync with the current state in case it changed before this subscriber mounted
    setStatus((prev) => {
      const offline = isAppOffline();
      if (prev.isOnline === !offline) return prev;
      return { isOnline: !offline, wasOffline: offline, lastOnlineTime: offline ? prev.lastOnlineTime : Date.now() };
    });

    return () => {
      active = false;
      listeners.delete(listener);
      stopMonitor();
    };
  }, []);

  return status;
}
