// Event constants for PosFlow
export const EVENTS = {
  // Sync Queue Events
  SYNC_QUEUE_UPDATED: 'syncQueueUpdated',
  PRODUCTS_UPDATED: 'posflow:products-updated',
  PRODUCT_DELETED: 'posflow:product-deleted',
  CATEGORIES_UPDATED: 'posflow:categories-updated',
  CUSTOMERS_UPDATED: 'posflow:customers-updated',
  DEBTS_UPDATED: 'posflow:debts-updated',
  MAINTENANCE_UPDATED: 'posflow:maintenance-updated',
  INVOICES_UPDATED: 'posflow:invoices-updated',
  SETTINGS_UPDATED: 'posflow:settings-updated',
  PARTNERS_UPDATED: 'posflow:partners-updated',
  EXPENSES_UPDATED: 'posflow:expenses-updated',
  SERVICES_UPDATED: 'posflow:services-updated',
  RECURRING_EXPENSES_UPDATED: 'posflow:recurring-expenses-updated',
  ACTIVITY_LOG_UPDATED: 'posflow:activity-log-updated',
  CASHBOX_UPDATED: 'posflow:cashbox-updated',
  SHIFTS_UPDATED: 'posflow:shifts-updated',
  CAPITAL_UPDATED: 'posflow:capital-updated',
  CASH_SHIFTS_UPDATED: 'posflow:cash-shifts-updated',
  PRODUCT_FIELDS_UPDATED: 'posflow:product-fields-updated',
  CUSTOM_FIELDS_UPDATED: 'posflow:custom-fields-updated',
  // Unified transaction events
  TRANSACTION_COMPLETED: 'posflow:transaction-completed',
  // Profit tracking events
  PROFITS_UPDATED: 'posflow:profits-updated',
  // Warehouse events
  WAREHOUSES_UPDATED: 'posflow:warehouses-updated',
  STOCK_TRANSFERS_UPDATED: 'posflow:stock-transfers-updated',
  STORE_TYPE_CHANGED: 'posflow:store-type-changed',
  THEME_CHANGED: 'posflow:theme-changed',
  PURCHASES_UPDATED: 'posflow:purchases-updated',
  // Silent Non-Blocking App Refresh Event (Pull to Refresh & Realtime Updates)
  APP_REFRESH: 'posflow:app-refresh',
};

// Subscribe to an event and return unsubscribe function
export function subscribeToEvent(eventName: string, callback: (event: CustomEvent) => void): () => void {
  const handler = (e: Event) => callback(e as CustomEvent);
  window.addEventListener(eventName, handler);
  return () => window.removeEventListener(eventName, handler);
}

export function emitEvent(name: string, detail?: any) {
  try {
    // Dispatch a single unified CustomEvent to notify listeners in the same window/tab
    window.dispatchEvent(new CustomEvent(name, { detail }));
  } catch {
    // ignore (server-side rendering or no window)
  }
}

export function emitAppRefresh(detail?: any) {
  emitEvent(EVENTS.APP_REFRESH, detail);
}
