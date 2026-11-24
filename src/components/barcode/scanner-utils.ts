/**
 * Native barcode-scanner helpers shared by the scanner UI and its callers.
 */
// Key used to persist the scanned barcode across potential app restarts
export const PENDING_BARCODE_KEY = 'posflow_pending_scan';

export function setScannerTransparency(active: boolean) {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('barcode-scanner-active', active);
  document.body.classList.toggle('barcode-scanner-active', active);

  try {
    window.dispatchEvent(new CustomEvent('posflow:scanner-state', { detail: { active } }));
  } catch (e) {
    console.warn('[Scanner] Event dispatch error:', e);
  }

  // Directly hide any open dialog/overlay elements in the DOM so native camera is 100% visible
  const dialogLayers = document.querySelectorAll<HTMLElement>(
    '[role="dialog"], .dialog-content-layer, .dialog-overlay-layer, [data-radix-portal], [data-radix-focus-guard]'
  );
  dialogLayers.forEach(el => {
    if (!el.closest('.barcode-scanner-modal') && !el.closest('.scanner-ui-overlay')) {
      if (active) {
        if (!el.dataset.scannerPrevDisplay) {
          el.dataset.scannerPrevDisplay = el.style.display || 'block';
        }
        el.style.setProperty('display', 'none', 'important');
        el.style.setProperty('visibility', 'hidden', 'important');
        el.style.setProperty('opacity', '0', 'important');
      } else {
        el.style.display = el.dataset.scannerPrevDisplay === 'block' ? '' : (el.dataset.scannerPrevDisplay || '');
        el.style.removeProperty('visibility');
        el.style.removeProperty('opacity');
        delete el.dataset.scannerPrevDisplay;
      }
    }
  });
}
