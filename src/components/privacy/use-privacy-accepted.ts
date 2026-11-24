import { useState, useCallback } from 'react';

const PRIVACY_KEY = 'posflow_privacy_accepted';
// Version 2: terms shown directly without button (v1 had a button)
const PRIVACY_VERSION = '2';
const PRIVACY_VERSION_KEY = 'posflow_privacy_version';

export function usePrivacyAccepted() {
  const [accepted, setAccepted] = useState(() => {
    try {
      const wasAccepted = localStorage.getItem(PRIVACY_KEY) === 'true';
      const savedVersion = localStorage.getItem(PRIVACY_VERSION_KEY) || '1';
      // Force re-acceptance if privacy screen version changed
      return wasAccepted && savedVersion === PRIVACY_VERSION;
    } catch {
      return false;
    }
  });

  const accept = useCallback(() => {
    try {
      localStorage.setItem(PRIVACY_KEY, 'true');
      localStorage.setItem(PRIVACY_VERSION_KEY, PRIVACY_VERSION);
    } catch (e) {
      console.warn('[Privacy] Failed to save privacy acceptance:', e);
    }
    setAccepted(true);
  }, []);

  return { accepted, accept };
}
