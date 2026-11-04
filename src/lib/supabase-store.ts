// Supabase Store - Cloud sync utilities for all data stores
import { supabase } from '@/integrations/supabase/client';
import type { SupabaseClient } from '@supabase/supabase-js';
import { showToast } from './toast-config';

// Loose-typed client for dynamic table access.
// The generated Database types only enumerate known tables, but this module is a
// generic utility layer that accepts table names as runtime strings, so we widen
// the type once here instead of sprinkling `any` across every call site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseSupabase = SupabaseClient<any, 'public', any>;
const sb = supabase as unknown as LooseSupabase;

// Shape of the `stores` row as consumed by the app. All fields optional/nullable
// because legacy rows may be missing newer columns.
export interface StoreSettingsRow {
  name?: string | null;
  store_type?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  logo_url?: string | null;
  primary_currency?: string | null;
  tax_enabled?: boolean | null;
  tax_rate?: number | null;
  notification_settings?: Record<string, unknown> | null;
  print_settings?: Record<string, unknown> | null;
  exchange_rates?: Record<string, number> | null;
  sync_settings?: Record<string, unknown> | null;
  [key: string]: unknown;
}


type UserRole = 'admin' | 'boss' | 'cashier';

interface UserRoleRow {
  role: UserRole;
  owner_id?: string | null;
}

// Current user ID cache
let currentUserId: string | null = null;
// Owner ID cache (for cashiers who need to write to owner's data)
let currentOwnerId: string | null = null;
// Current user role cache
let currentUserRole: UserRole | null = null;

export const setCurrentUserId = (userId: string | null) => {
  currentUserId = userId;
  // Reset caches when user changes
  currentOwnerId = null;
  currentUserRole = null;
};

export const getCurrentUserId = (): string | null => {
  if (currentUserId) return currentUserId;
  try {
    const cached = localStorage.getItem('hyperpos_session_cache');
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed?.user?.id) {
        currentUserId = parsed.user.id;
        return currentUserId;
      }
    }
    // Check standard Supabase auth token key in localStorage
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
        const raw = localStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed?.user?.id) {
            currentUserId = parsed.user.id;
            return currentUserId;
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
};

export const getCurrentUserName = (): string | null => {
  try {
    const cached = localStorage.getItem('hyperpos_session_cache');
    if (cached) {
      const parsed = JSON.parse(cached);
      const name = parsed?.user?.user_metadata?.full_name || parsed?.user?.user_metadata?.name || parsed?.user?.email;
      if (name) return name;
    }
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
        const raw = localStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          const name = parsed?.user?.user_metadata?.full_name || parsed?.user?.user_metadata?.name || parsed?.user?.email;
          if (name) return name;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
};

// Get user role (cached)
export const getCurrentUserRole = async (): Promise<UserRole | null> => {
  if (currentUserRole) return currentUserRole;

  let userId = getCurrentUserId();
  if (!userId) {
    try {
      const { data } = await supabase.auth.getSession();
      if (data?.session?.user?.id) {
        userId = data.session.user.id;
        setCurrentUserId(userId);
      }
    } catch {
      /* ignore */
    }
  }
  if (!userId) return null;

  try {
    const { data, error } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .maybeSingle();

    if (error || !data) return null;

    currentUserRole = data.role as UserRole;
    return currentUserRole;
  } catch {
    return null;
  }
};

// Check if current user is cashier
export const isCashierUser = async (): Promise<boolean> => {
  const role = await getCurrentUserRole();
  return role === 'cashier';
};

// Get owner ID (for cashiers, this returns their owner; for admins/boss, returns themselves)
export const getOwnerIdForInsert = async (): Promise<string | null> => {
  // If cached, return cached value
  if (currentOwnerId) return currentOwnerId;

  let userId = getCurrentUserId();
  if (!userId) {
    try {
      const { data } = await supabase.auth.getSession();
      if (data?.session?.user?.id) {
        userId = data.session.user.id;
        setCurrentUserId(userId);
      }
    } catch {
      /* ignore */
    }
  }
  if (!userId) return null;

  try {
    // Query user_roles to get owner_id
    const { data, error } = await supabase
      .from('user_roles')
      .select('role, owner_id')
      .eq('user_id', userId)
      .maybeSingle<UserRoleRow>();

    if (error || !data) {
      console.warn('[getOwnerIdForInsert] Could not fetch role, using self as owner');
      return userId;
    }

    // Cache the role
    currentUserRole = data.role;

    // If admin or boss, or if owner_id is missing, user is their own owner
    if (data.role === 'admin' || data.role === 'boss' || !data.owner_id) {
      currentOwnerId = userId;
      return userId;
    }

    // If staff (cashier, distributor, etc.) with owner_id, use owner_id
    currentOwnerId = data.owner_id;
    console.log('[getOwnerIdForInsert] Staff owner_id:', currentOwnerId);
    return data.owner_id;

    // Fallback to self
    return userId;
  } catch (error) {
    console.error('[getOwnerIdForInsert] Error:', error);
    return userId;
  }
};

/**
 * Helper to wrap any async operation with a strict timeout.
 * Prevents requests from hanging indefinitely on dead VPN connections or severed mobile networks.
 */
export async function withTimeout<T>(
  promise: Promise<T> | PromiseLike<T>,
  timeoutMs: number = 3800,
  fallbackValue?: T
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      if (fallbackValue !== undefined) {
        resolve(fallbackValue);
      } else {
        reject(new Error(`[NetworkTimeout] Operation timed out after ${timeoutMs}ms (VPN / dead connection)`));
      }
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timer!);
    return result;
  } catch (err) {
    clearTimeout(timer!);
    if (fallbackValue !== undefined) return fallbackValue;
    throw err;
  }
}

// Generic fetch function with error handling, timeout protection, and automatic pagination
// ✅ يعتمد على RLS (get_owner_id) لتصفية البيانات تلقائياً
// ✅ يدعم الترقيم التلقائي (Chunked Pagination) لمنع بتر البيانات الصامت عند سقف 1000 صف في المتاجر الكبيرة
const SUPABASE_PAGE_SIZE = 1000;
const MAX_PAGINATION_ROWS = 50000;

export async function fetchFromSupabase<T = unknown>(
  tableName: string,
  orderBy?: { column: string; ascending?: boolean },
  timeoutMs: number = 3800
): Promise<T[]> {
  const userId = getCurrentUserId();
  if (!userId) {
    console.warn(`fetchFromSupabase: No user ID for ${tableName}`);
    return [];
  }

  // Fast offline check
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return [];
  }

  try {
    // ✅ جلب الدفعة الأولى بطلب ذرّي بنطاق 0 إلى 999
    let query = sb.from(tableName).select('*').range(0, SUPABASE_PAGE_SIZE - 1);

    if (orderBy) {
      query = query.order(orderBy.column, { ascending: orderBy.ascending ?? false });
    }

    const res = await withTimeout(
      Promise.resolve(query),
      timeoutMs,
      { data: null, error: new Error(`Timeout fetching ${tableName}`) } as any
    );
    const data = res?.data;
    const error = res?.error;

    if (error) {
      console.warn(`[Supabase] Warning/timeout fetching ${tableName}:`, error);
      return [];
    }

    if (!data || !Array.isArray(data)) {
      return [];
    }

    // إذا كانت النتائج أقل من سقف الصفحة (1000)، نعيدها فوراً بطلب واحد 0ms تأخير إضافي
    if (data.length < SUPABASE_PAGE_SIZE) {
      return data as T[];
    }

    // للمتاجر الكبيرة: إذا بلغ الاستعلام سقف 1000 صف، نستمر بجلب باقي الصفحات تلقائياً
    const allData: T[] = [...(data as T[])];
    let offset = SUPABASE_PAGE_SIZE;

    while (allData.length < MAX_PAGINATION_ROWS) {
      let pageQuery = sb.from(tableName).select('*').range(offset, offset + SUPABASE_PAGE_SIZE - 1);
      if (orderBy) {
        pageQuery = pageQuery.order(orderBy.column, { ascending: orderBy.ascending ?? false });
      }

      const pageRes = await withTimeout(
        Promise.resolve(pageQuery),
        timeoutMs,
        { data: null, error: new Error(`Timeout fetching page at offset ${offset} for ${tableName}`) } as any
      );

      if (pageRes?.error || !pageRes?.data || !Array.isArray(pageRes.data) || pageRes.data.length === 0) {
        break;
      }

      allData.push(...(pageRes.data as T[]));

      if (pageRes.data.length < SUPABASE_PAGE_SIZE) {
        break; // وصلنا لآخر صفحة
      }

      offset += SUPABASE_PAGE_SIZE;
    }

    return allData;
  } catch (error) {
    console.warn(`[Supabase] Error fetching ${tableName}:`, error);
    return [];
  }
}

// Prevents HTTP 400 Bad Request errors caused by unexpected or computed client fields
export const TABLE_ALLOWED_COLUMNS: Record<string, string[]> = {
  invoices: [
    'id', 'user_id', 'invoice_number', 'invoice_sequence', 'invoice_type', 'date', 'time',
    'cashier_id', 'cashier_name', 'customer_id', 'customer_name', 'customer_phone',
    'subtotal', 'discount', 'discount_percentage', 'tax_rate', 'tax_amount', 'total',
    'profit', 'currency', 'exchange_rate', 'payment_type', 'status', 'debt_paid',
    'debt_remaining', 'notes', 'operation_id', 'warehouse_id',
    // ✅ الأعمدة المعتمدة والموجودة فعلياً:
    'tax_inclusive', 'settlement_kind', 'settlement_diff_usd',
    'created_at', 'updated_at'
  ],
  invoice_items: [
    'id', 'invoice_id', 'product_id', 'product_name', 'barcode', 'category', 'quantity',
    'unit_price', 'cost_price', 'amount_original', 'amount_usd', 'profit', 'unit',
    'conversion_factor', 'stock_warehouse_id', 'created_at'
  ],
  // ✅ إصلاح N-04: تمكين الحقول المعتمدة للمنتجات
  products: [
    'id', 'user_id', 'name', 'barcode', 'barcode2', 'barcode3', 'variant_label', 'category',
    'cost_price', 'sale_price', 'wholesale_price', 'quantity', 'min_stock_level', 'expiry_date',
    'image_url', 'custom_fields', 'purchase_history', 'is_taxable', 'tax_rate', 'track_stock',
    'is_active', 'archived', 'labor_cost', 'bulk_unit', 'small_unit', 'conversion_factor',
    'bulk_cost_price', 'bulk_sale_price', 'track_by_unit',
    'unit', 'supplier', 'location', 'notes', 'description', 'warranty_months',
    'serial_number', 'batch_number', 'weight', 'size', 'color', 'fabric_type',
    'author', 'publisher', 'table_number', 'order_notes',
    'created_at', 'updated_at'
  ],
  profit_records: [
    'id', 'user_id', 'invoice_id', 'revenue', 'cogs', 'gross_profit', 'currency',
    'recorded_at', 'is_reversed', 'reversed_at', 'created_at'
  ],
  cash_shifts: [
    'id', 'user_id', 'cashier_id', 'cashier_name', 'opened_at', 'closed_at',
    'opening_balance', 'expected_balance', 'actual_balance', 'variance',
    'variance_reason', 'reconciliation_status', 'notes', 'created_at', 'updated_at'
  ],
  shift_transactions: [
    'id', 'user_id', 'shift_id', 'type', 'amount', 'reference_id', 'notes',
    'currency', 'currency_amount', 'exchange_rate',
    'created_at'
  ],
  purchase_invoices: [
    'id', 'user_id', 'invoice_number', 'supplier_name', 'supplier_company', 'invoice_date',
    'expected_items_count', 'expected_total_quantity', 'expected_grand_total',
    'actual_items_count', 'actual_total_quantity', 'actual_grand_total',
    'status', 'notes', 'image_url', 'created_at', 'updated_at'
  ],
  purchase_invoice_items: [
    'id', 'invoice_id', 'product_id', 'product_name', 'barcode', 'category',
    'quantity', 'cost_price', 'cost_price_before', 'sale_price', 'total_cost', 'created_at'
  ],
  customers: [
    'id', 'user_id', 'cashier_id', 'name', 'phone', 'email', 'address',
    'total_debt', 'total_purchases', 'invoice_count', 'last_purchase', 'created_at', 'updated_at'
  ],
  debts: [
    'id', 'user_id', 'cashier_id', 'customer_name', 'customer_phone', 'invoice_id',
    'total_debt', 'total_paid', 'remaining_debt', 'status', 'due_date', 'notes',
    'is_cash_debt', 'created_at', 'updated_at'
  ],
  expenses: [
    'id', 'user_id', 'cashier_id', 'expense_type', 'amount', 'description',
    'distributions', 'date', 'notes', 'status', 'is_reversed', 'reversed_at',
    'reversed_by', 'reversed_reason', 'reversal_reason', 'created_at'
  ],
  categories: [
    'id', 'user_id', 'name', 'created_at'
  ],
  maintenance_services: [
    'id', 'user_id', 'customer_name', 'customer_phone', 'description',
    'service_price', 'parts_cost', 'profit', 'payment_type', 'status', 'created_at'
  ],
  activity_log: [
    'id', 'user_id', 'actor_id', 'actor_name', 'actor_role', 'action_type',
    'description', 'entity_id', 'entity_name', 'entity_type', 'metadata', 'created_at'
  ],
  // ✅ إصلاح BUG-01: تمكين كافة الحقول المحاسبية للشركاء
  partners: [
    'id', 'user_id', 'name', 'phone', 'email', 'percentage', 'share_percentage', 'notes',
    'capital', 'current_balance', 'total_profit_earned', 'total_withdrawn',
    'expense_share_percentage', 'shares_expenses', 'confirmed_profit', 'pending_profit',
    'profit_history', 'withdrawal_history', 'expense_history', 'category_shares',
    'is_full_partner', 'joined_at', 'status', 'is_active', 'created_at', 'updated_at'
  ],
  warehouses: [
    'id', 'user_id', 'name', 'location', 'type', 'is_default', 'is_active', 'notes',
    'created_at', 'updated_at'
  ],
  warehouse_stock: [
    'id', 'warehouse_id', 'product_id', 'quantity', 'last_updated', 'created_at'
  ],
  recurring_expenses: [
    'id', 'user_id', 'name', 'expense_type', 'custom_type', 'amount', 'description',
    'interval', 'interval_days', 'next_due_date', 'last_paid_date', 'auto_pay',
    'currency', 'original_amount', // ✅ الأعمدة الفعلية المضافة بالهجرة
    'notes', 'is_active', 'created_at', 'updated_at'
  ]
};

export function filterTablePayload<T extends Record<string, unknown>>(tableName: string, data: T): Record<string, unknown> {
  const allowed = TABLE_ALLOWED_COLUMNS[tableName];
  if (!allowed) {
    const { uniqueKey, _operation, bundle, localId, items, stockItems, ...rest } = data;
    return rest;
  }
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(data)) {
    if (allowed.includes(key)) {
      clean[key] = data[key];
    }
  }
  return clean;
}

// Generic insert function
// ✅ Uses getOwnerIdForInsert to properly set user_id for cashiers
export async function insertToSupabase<T = unknown>(
  tableName: string,
  data: Record<string, unknown>,
  options?: { silent?: boolean }
): Promise<T | null> {
  // Get owner ID (for cashiers this returns their owner's ID)
  const ownerId = await getOwnerIdForInsert();
  if (!ownerId) {
    console.warn(`insertToSupabase: No owner ID for ${tableName}`);
    return null;
  }

  try {
    const sanitized = filterTablePayload(tableName, data);
    const { data: inserted, error } = await sb
      .from(tableName)
      .insert({ ...sanitized, user_id: ownerId })
      .select()
      .single();

    if (error) {
      console.error(`Error inserting to ${tableName}:`, error.message, error.details || '', error.hint || '');
      // ✅ Only show toast if not silent mode
      if (!options?.silent) {
        showToast.error('فشل في حفظ البيانات', { description: error.message });
      }
      return null;
    }

    return inserted as T;
  } catch (error) {
    console.error(`Error inserting to ${tableName}:`, error);
    return null;
  }
}

// Generic update function
// ✅ Uses getOwnerIdForInsert to properly handle cashier updates
export async function updateInSupabase(
  tableName: string,
  id: string,
  updates: Record<string, unknown>
): Promise<boolean> {
  // Use owner ID for cashiers (they update owner's records)
  const ownerId = await getOwnerIdForInsert();
  if (!ownerId) {
    console.warn(`updateInSupabase: No owner ID for ${tableName}`);
    return false;
  }

  try {
    const sanitized = filterTablePayload(tableName, updates);
    const { error } = await sb
      .from(tableName)
      .update(sanitized)
      .eq('id', id)
      .eq('user_id', ownerId);

    if (error) {
      console.error(`Error updating ${tableName}:`, error.message, error.details || '', error.hint || '');
      return false;
    }

    return true;
  } catch (error) {
    console.error(`Error updating ${tableName}:`, error);
    return false;
  }
}

// Generic delete function
// ✅ Uses getOwnerIdForInsert to properly handle cashier deletes
export async function deleteFromSupabase(
  tableName: string,
  id: string
): Promise<boolean> {
  // Use owner ID for cashiers (they delete owner's records)
  const ownerId = await getOwnerIdForInsert();
  if (!ownerId) {
    console.warn(`deleteFromSupabase: No owner ID for ${tableName}`);
    return false;
  }

  try {
    const { error } = await sb
      .from(tableName)
      .delete()
      .eq('id', id)
      .eq('user_id', ownerId);

    if (error) {
      console.error(`Error deleting from ${tableName}:`, error);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`Error deleting from ${tableName}:`, error);
    return false;
  }
}

// Batch insert function for migration
// ✅ Uses getOwnerIdForInsert for proper user_id
export async function batchInsertToSupabase(
  tableName: string,
  items: Record<string, unknown>[]
): Promise<boolean> {
  const ownerId = await getOwnerIdForInsert();
  if (!ownerId || items.length === 0) return true;

  try {
    // Add user_id to all items using owner's ID
    const itemsWithUserId = items.map(item => ({
      ...item,
      user_id: ownerId,
    }));

    // Insert in batches of 100
    const batchSize = 100;
    for (let i = 0; i < itemsWithUserId.length; i += batchSize) {
      const batch = itemsWithUserId.slice(i, i + batchSize);
      const { error } = await sb.from(tableName).insert(batch);

      if (error) {
        console.error(`Error batch inserting to ${tableName}:`, error);
        return false;
      }
    }

    return true;
  } catch (error) {
    console.error(`Error batch inserting to ${tableName}:`, error);
    return false;
  }
}

// Upsert function (insert or update)
// ✅ Uses getOwnerIdForInsert for proper user_id
export async function upsertToSupabase<T = unknown>(
  tableName: string,
  data: Record<string, unknown>,
  conflictColumn: string = 'id'
): Promise<T | null> {
  const ownerId = await getOwnerIdForInsert();
  if (!ownerId) {
    console.warn(`upsertToSupabase: No owner ID for ${tableName}`);
    return null;
  }

  try {
    const sanitized = filterTablePayload(tableName, data);
    const { data: upserted, error } = await sb
      .from(tableName)
      .upsert({ ...sanitized, user_id: ownerId }, { onConflict: conflictColumn })
      .select()
      .single();

    if (error) {
      console.error(`Error upserting to ${tableName}:`, error);
      return null;
    }

    return upserted as T;
  } catch (error) {
    console.error(`Error upserting to ${tableName}:`, error);
    return null;
  }
}

// Incremental fetch: get records updated since a given timestamp
export async function fetchIncrementalFromSupabase<T = unknown>(
  tableName: string,
  since: string,
  orderBy?: { column: string; ascending?: boolean },
  timeoutMs: number = 3800
): Promise<T[]> {
  const userId = getCurrentUserId();
  if (!userId) return [];

  // Fast offline check
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return [];
  }

  try {
    let query = sb.from(tableName).select('*').gt('updated_at', since);

    if (orderBy) {
      query = query.order(orderBy.column, { ascending: orderBy.ascending ?? false });
    }

    const res = await withTimeout(
      Promise.resolve(query),
      timeoutMs,
      { data: null, error: new Error(`Timeout incremental fetching ${tableName}`) } as any
    );
    const data = res?.data;
    const error = res?.error;

    if (error) {
      console.warn(`[Supabase] Warning/timeout incremental fetch ${tableName}:`, error);
      return [];
    }

    return (data || []) as T[];
  } catch (error) {
    console.warn(`[Supabase] Error incremental fetch ${tableName}:`, error);
    return [];
  }
}

// Check if user has data in cloud
export async function hasCloudData(tableName: string): Promise<boolean> {
  const userId = getCurrentUserId();
  if (!userId) return false;

  try {
    const { count, error } = await sb
      .from(tableName)
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    if (error) {
      console.error(`Error checking ${tableName}:`, error);
      return false;
    }

    return (count || 0) > 0;
  } catch (error) {
    console.error(`Error checking ${tableName}:`, error);
    return false;
  }
}

// Fetch store settings
// ✅ Uses getOwnerIdForInsert to fetch owner's store settings for cashiers
export async function fetchStoreSettings(timeoutMs: number = 1500): Promise<StoreSettingsRow | null> {
  // For reading, use owner ID so cashiers see their owner's settings
  const ownerId = await getOwnerIdForInsert();
  if (!ownerId) return null;

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return null;
  }

  try {
    const query = supabase
      .from('stores')
      .select('*')
      .eq('user_id', ownerId)
      .maybeSingle();

    const res = await withTimeout(
      Promise.resolve(query),
      timeoutMs,
      { data: null, error: new Error('Timeout fetching store settings') } as any
    );
    const data = res?.data;
    const error = res?.error;

    if (error) {
      console.warn('[Supabase] Warning/timeout fetching store settings:', error);
      return null;
    }

    return data as StoreSettingsRow | null;
  } catch (error) {
    console.warn('[Supabase] Error fetching store settings:', error);
    return null;
  }
}


// Save store settings directly to Supabase
// ✅ Uses getOwnerIdForInsert - cashiers should NOT save store settings
export async function saveStoreSettingsDirect(settings: Record<string, unknown>): Promise<boolean> {
  const ownerId = await getOwnerIdForInsert();
  if (!ownerId) return false;

  try {
    // Check if store exists using owner's ID
    const { data: existing } = await supabase
      .from('stores')
      .select('id, sync_settings')
      .eq('user_id', ownerId)
      .maybeSingle();

    if (existing) {
      // Merge sync_settings if provided so we never wipe existing keys (like customFields, productFieldsConfig)
      const payloadToSave: Record<string, unknown> = { ...settings };
      if (settings.sync_settings && typeof settings.sync_settings === 'object') {
        const existingSync = (existing.sync_settings as Record<string, unknown>) || {};
        payloadToSave.sync_settings = {
          ...existingSync,
          ...(settings.sync_settings as Record<string, unknown>),
          appearanceProfiles: {
            ...((existingSync.appearanceProfiles as Record<string, unknown>) || {}),
            ...(((settings.sync_settings as Record<string, unknown>).appearanceProfiles as Record<string, unknown>) || {}),
          },
        };
      }

      // Update existing
      let { error } = await sb
        .from('stores')
        .update(payloadToSave)
        .eq('user_id', ownerId);

      // Graceful fallback if primary_currency column does not exist in stores schema cache
      if (error && payloadToSave.primary_currency && (String(error.message || '').includes('primary_currency') || (error as any).code === 'PGRST204')) {
        const fallbackPayload = { ...payloadToSave };
        delete fallbackPayload.primary_currency;
        const retry = await sb
          .from('stores')
          .update(fallbackPayload)
          .eq('user_id', ownerId);
        error = retry.error;
      }

      if (error) {
        console.error('Error updating store settings:', error);
        return false;
      }
    } else {
      // Insert new using owner's ID
      const { error } = await sb
        .from('stores')
        .insert({ ...settings, user_id: ownerId });

      if (error) {
        console.error('Error inserting store settings:', error);
        return false;
      }
    }

    return true;
  } catch (error) {
    console.error('Error saving store settings:', error);
    return false;
  }
}

// Save store settings with Offline-First support and Sync Queue
export async function saveStoreSettings(settings: Record<string, unknown>): Promise<boolean> {
  // If offline, save into sync queue immediately
  if (!navigator.onLine) {
    try {
      const { enqueueStoreSettingsUpdate } = await import('./sync-queue');
      enqueueStoreSettingsUpdate(settings);
      console.log('[StoreSettings] Saved offline to consolidated sync queue');
    } catch (e) {
      console.warn('[StoreSettings] Failed to enqueue offline settings update:', e);
    }
    return true;
  }

  // If online, attempt direct save; on failure, enqueue to sync queue
  const success = await saveStoreSettingsDirect(settings);
  if (!success) {
    try {
      const { enqueueStoreSettingsUpdate } = await import('./sync-queue');
      enqueueStoreSettingsUpdate(settings);
      console.log('[StoreSettings] Enqueued to consolidated sync queue after network failure');
      return true;
    } catch {
      return false;
    }
  }

  return true;
}

// Delete all user data (for data reset via unified RPC)
export async function deleteAllUserData(): Promise<boolean> {
  try {
    const { error } = await (supabase.rpc as any)('reset_user_store_data');
    if (error) {
      console.error('[deleteAllUserData] RPC reset_user_store_data error:', error);
      return false;
    }
    console.log('[deleteAllUserData] reset_user_store_data executed successfully');
    return true;
  } catch (error) {
    console.error('Error deleting user data via RPC reset_user_store_data:', error);
    return false;
  }
}
