import * as React from 'react';

export function useIsScannerActive() {
  const [active, setActive] = React.useState(() =>
    typeof document !== 'undefined' && document.body.classList.contains('barcode-scanner-active')
  );

  React.useEffect(() => {
    const handleState = (e: Event) => {
      const customEvent = e as CustomEvent<{ active: boolean }>;
      if (customEvent.detail && typeof customEvent.detail.active === 'boolean') {
        setActive(customEvent.detail.active);
      } else if (typeof document !== 'undefined') {
        setActive(document.body.classList.contains('barcode-scanner-active'));
      }
    };
    window.addEventListener('posflow:scanner-state', handleState);
    return () => {
      window.removeEventListener('posflow:scanner-state', handleState);
    };
  }, []);

  return active;
}
