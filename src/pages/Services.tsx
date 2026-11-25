import { isLocalDataMode } from '@/hooks/use-network-status';
import { PageHeader } from '@/components/layout/PageHeader';
import { useState, useEffect } from 'react';
import {
  Search,
  Plus,
  Phone,
  Calendar,
  Wrench,
  Clock,
  CheckCircle,
  Eye,
  Edit,
  Undo2,
  Save,
  User,
  Smartphone,
  AlertCircle,
  XCircle,
  DollarSign,
  Loader2
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DatePicker } from '@/components/ui/date-picker';
import { toast } from '@/lib/sonner-bridge';
import { EVENTS, emitEvent } from '@/lib/events';
import { useLanguage } from '@/hooks/language-context';
import { useAuth } from '@/hooks/auth-context';
import { useDeferWhileHidden } from '@/contexts/page-activity-context';

interface RepairRequest {
  id: string;
  customerName: string;
  customerPhone: string;
  deviceType: string;
  deviceModel: string;
  issue: string;
  diagnosis?: string;
  estimatedCost?: number;
  finalCost?: number;
  status: 'pending' | 'in_progress' | 'waiting_parts' | 'completed' | 'cancelled' | 'delivered' | 'refunded';
  createdAt: string;
  estimatedDate?: string;
  completedAt?: string;
  notes?: string;
  technician?: string;
  // Delivery fields
  partsCost?: number;        // تكلفة القطع علينا
  amountReceived?: number;   // المبلغ المقبوض من العميل
  profit?: number;           // الربح الصافي
  paymentType?: 'cash' | 'debt';  // نوع الدفع
  deliveredAt?: string;      // تاريخ التسليم
  // Cashier attribution
  createdById?: string;
  createdByName?: string;
}

const SERVICES_STORAGE_KEY = 'posflow_services_v1';

// Helper to generate standard UUID
const generateServiceUUID = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

interface CloudMaintenanceRow {
  id: string;
  user_id: string;
  customer_name: string;
  customer_phone: string | null;
  description: string | null;
  parts_cost: number | null;
  payment_type: string | null;
  profit: number | null;
  service_price: number | null;
  status: string | null;
  created_at: string | null;
}

function requestToCloudPayload(req: RepairRequest) {
  const meta = {
    deviceType: req.deviceType,
    deviceModel: req.deviceModel,
    issue: req.issue,
    diagnosis: req.diagnosis,
    technician: req.technician,
    estimatedDate: req.estimatedDate,
    notes: req.notes,
    completedAt: req.completedAt,
    deliveredAt: req.deliveredAt,
    amountReceived: req.amountReceived,
    estimatedCost: req.estimatedCost,
    finalCost: req.finalCost,
    createdById: req.createdById,
    createdByName: req.createdByName,
  };

  return {
    id: req.id,
    customer_name: req.customerName,
    customer_phone: req.customerPhone || null,
    description: JSON.stringify(meta),
    service_price: req.finalCost ?? req.estimatedCost ?? 0,
    parts_cost: req.partsCost ?? 0,
    profit: req.profit ?? 0,
    payment_type: req.paymentType || null,
    status: req.status,
    created_at: req.createdAt ? (req.createdAt.includes('T') ? req.createdAt : `${req.createdAt}T00:00:00.000Z`) : new Date().toISOString(),
  };
}

function cloudRowToRequest(row: CloudMaintenanceRow): RepairRequest {
  let meta: { deviceType?: string; deviceModel?: string; issue?: string; diagnosis?: string; estimatedCost?: number; finalCost?: number; estimatedDate?: string; completedAt?: string; notes?: string; technician?: string; amountReceived?: number; deliveredAt?: string; createdById?: string; createdByName?: string } = {};
  if (row.description) {
    try {
      meta = JSON.parse(row.description);
    } catch {
      meta = { issue: row.description };
    }
  }

  return {
    id: row.id,
    customerName: row.customer_name || 'عميل',
    customerPhone: row.customer_phone || '',
    deviceType: meta.deviceType || 'هاتف',
    deviceModel: meta.deviceModel || '',
    issue: meta.issue || '',
    diagnosis: meta.diagnosis,
    estimatedCost: meta.estimatedCost ?? (row.service_price !== null ? Number(row.service_price) : undefined),
    finalCost: meta.finalCost ?? (row.service_price !== null ? Number(row.service_price) : undefined),
    status: (row.status as RepairRequest['status']) || 'pending',
    createdAt: row.created_at ? row.created_at.split('T')[0] : new Date().toISOString().split('T')[0],
    estimatedDate: meta.estimatedDate,
    completedAt: meta.completedAt,
    notes: meta.notes,
    technician: meta.technician,
    partsCost: row.parts_cost !== null ? Number(row.parts_cost) : undefined,
    amountReceived: meta.amountReceived ?? (row.service_price !== null ? Number(row.service_price) : undefined),
    profit: row.profit !== null ? Number(row.profit) : undefined,
    paymentType: (row.payment_type as 'cash' | 'debt') || undefined,
    deliveredAt: meta.deliveredAt,
    createdById: meta.createdById,
    createdByName: meta.createdByName,
  };
}

const syncServiceToCloud = async (req: RepairRequest) => {
  const payload = requestToCloudPayload(req);
  if (typeof navigator !== 'undefined' && isLocalDataMode()) {
    const { addToQueue } = await import('@/lib/sync-queue');
    addToQueue('maintenance_upsert', payload);
    return;
  }

  try {
    const { upsertToSupabase } = await import('@/lib/supabase-store');
    const res = await upsertToSupabase('maintenance_services', payload);
    if (!res) {
      const { addToQueue } = await import('@/lib/sync-queue');
      addToQueue('maintenance_upsert', payload);
    }
  } catch {
    const { addToQueue } = await import('@/lib/sync-queue');
    addToQueue('maintenance_upsert', payload);
  }
};


// Load services from localStorage
const loadServices = (): RepairRequest[] => {
  try {
    const stored = localStorage.getItem(SERVICES_STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
};

// Save services to localStorage
const saveServices = (services: RepairRequest[]) => {
  try {
    localStorage.setItem(SERVICES_STORAGE_KEY, JSON.stringify(services));
    emitEvent(EVENTS.SERVICES_UPDATED, services);
  } catch {
    // ignore
  }
};

const getStatusConfig = (t: (key: string) => string) => ({
  pending: { label: t('services.pending'), icon: Clock, color: 'bg-warning/15 text-warning border-warning/30' },
  in_progress: { label: t('services.inProgress'), icon: Wrench, color: 'bg-info/15 text-info border-info/30' },
  waiting_parts: { label: t('services.waitingParts'), icon: AlertCircle, color: 'bg-warning/15 text-warning border-warning/30' },
  completed: { label: t('services.completed'), icon: CheckCircle, color: 'bg-success/15 text-success border-success/30' },
  cancelled: { label: t('services.cancelled'), icon: XCircle, color: 'bg-destructive/15 text-destructive border-destructive/30' },
  delivered: { label: t('services.delivered'), icon: CheckCircle, color: 'bg-success/15 text-success border-success/30' },
  refunded: { label: 'مسترجع', icon: Undo2, color: 'bg-warning/15 text-warning border-warning/30' },
});

const getFilterOptions = (t: (key: string) => string) => [
  { key: 'all', label: t('services.all') },
  { key: 'pending', label: t('services.pending') },
  { key: 'in_progress', label: t('services.inProgress') },
  { key: 'waiting_parts', label: t('services.waitingParts') },
  { key: 'completed', label: t('services.completed') },
  { key: 'delivered', label: t('services.delivered') },
  { key: 'cancelled', label: t('services.cancelled') },
];

const getDeviceTypes = (t: (key: string) => string) => [
  { key: 'phone', label: t('services.deviceTypes.phone') },
  { key: 'tablet', label: t('services.deviceTypes.tablet') },
  { key: 'laptop', label: t('services.deviceTypes.laptop') },
  { key: 'computer', label: t('services.deviceTypes.computer') },
  { key: 'smartwatch', label: t('services.deviceTypes.smartwatch') },
  { key: 'other', label: t('services.deviceTypes.other') },
];

export default function Services() {
  const deferWhileHidden = useDeferWhileHidden();
  const { t, isRTL } = useLanguage();
  const { user, profile } = useAuth();
  const statusConfig = getStatusConfig(t);
  const filterOptions = getFilterOptions(t);
  const deviceTypes = getDeviceTypes(t);

  const [requests, setRequests] = useState<RepairRequest[]>(() => loadServices());
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFilter, setSelectedFilter] = useState('all');

  // Save to localStorage whenever requests change
  useEffect(() => {
    saveServices(requests);
  }, [requests]);

  // Cloud sync: fetch & merge on mount and on EVENTS.MAINTENANCE_UPDATED
  useEffect(() => {
    const fetchCloudServices = async () => {
      if (typeof navigator !== 'undefined' && isLocalDataMode()) return;
      try {
        const { fetchFromSupabase } = await import('@/lib/supabase-store');
        const rows = await fetchFromSupabase<CloudMaintenanceRow>('maintenance_services', {
          column: 'created_at',
          ascending: false,
        });
        if (rows && rows.length > 0) {
          setRequests(prev => {
            const byId = new Map<string, RepairRequest>();
            for (const r of prev) {
              byId.set(r.id, r);
            }
            for (const row of rows) {
              const req = cloudRowToRequest(row);
              byId.set(req.id, req);
            }
            const merged = Array.from(byId.values()).sort((a, b) =>
              (b.createdAt || '').localeCompare(a.createdAt || '')
            );
            saveServices(merged);
            return merged;
          });
        }
      } catch (err) {
        console.warn('[Services] Cloud fetch skipped:', err);
      }
    };

    void fetchCloudServices();

    const handleMaintenanceUpdate = () => {
      deferWhileHidden('services', () => { void fetchCloudServices(); });
    };
    window.addEventListener(EVENTS.MAINTENANCE_UPDATED, handleMaintenanceUpdate);
    return () => {
      window.removeEventListener(EVENTS.MAINTENANCE_UPDATED, handleMaintenanceUpdate);
    };
  }, [deferWhileHidden]);

  // Dialogs & Views
  const [activeView, setActiveView] = useState<'list' | 'add' | 'edit'>('list');
  const showAddDialog = activeView === 'add';
  const showEditDialog = activeView === 'edit';
  const setShowAddDialog = (open: boolean) => {
    setActiveView(open ? 'add' : 'list');
    if (open) window.scrollTo({ top: 0, behavior: 'instant' });
  };
  const setShowEditDialog = (open: boolean) => {
    setActiveView(open ? 'edit' : 'list');
    if (open) window.scrollTo({ top: 0, behavior: 'instant' });
  };
  const [showViewDialog, setShowViewDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showDeliveryDialog, setShowDeliveryDialog] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState<RepairRequest | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Delivery form state
  const [deliveryData, setDeliveryData] = useState({
    partsCost: 0,
    amountReceived: 0,
    paymentType: 'cash' as 'cash' | 'debt',
  });

  // Form state
  const [formData, setFormData] = useState({
    customerName: '',
    customerPhone: '',
    deviceType: 'phone',
    deviceModel: '',
    issue: '',
    diagnosis: '',
    estimatedCost: 0,
    estimatedDate: '',
    notes: '',
    technician: '',
  });

  const filterStatusMap: Record<string, string | null> = {
    'all': null,
    'pending': 'pending',
    'in_progress': 'in_progress',
    'waiting_parts': 'waiting_parts',
    'completed': 'completed',
    'delivered': 'delivered',
    'cancelled': 'cancelled',
  };

  const filteredRequests = requests.filter(request => {
    const matchesSearch = request.customerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      request.customerPhone.includes(searchQuery) ||
      request.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      request.deviceModel.toLowerCase().includes(searchQuery.toLowerCase());
    const filterStatus = filterStatusMap[selectedFilter] || null;
    const matchesFilter = !filterStatus || request.status === filterStatus;
    return matchesSearch && matchesFilter;
  });

  const stats = {
    total: requests.length,
    pending: requests.filter(r => r.status === 'pending').length,
    inProgress: requests.filter(r => r.status === 'in_progress' || r.status === 'waiting_parts').length,
    completed: requests.filter(r => r.status === 'completed' || r.status === 'delivered').length,
  };

  const resetForm = () => {
    setFormData({
      customerName: '',
      customerPhone: '',
      deviceType: 'phone',
      deviceModel: '',
      issue: '',
      diagnosis: '',
      estimatedCost: 0,
      estimatedDate: '',
      notes: '',
      technician: '',
    });
  };

  const handleAddRequest = () => {
    if (!formData.customerName || !formData.customerPhone || !formData.deviceModel || !formData.issue) {
      toast.error(t('services.fillAllFields'));
      return;
    }

    const deviceLabel = deviceTypes.find(d => d.key === formData.deviceType)?.label || formData.deviceType;

    const newRequest: RepairRequest = {
      id: generateServiceUUID(),
      customerName: formData.customerName,
      customerPhone: formData.customerPhone,
      deviceType: deviceLabel,
      deviceModel: formData.deviceModel,
      issue: formData.issue,
      diagnosis: formData.diagnosis || undefined,
      estimatedCost: formData.estimatedCost || undefined,
      estimatedDate: formData.estimatedDate || undefined,
      notes: formData.notes || undefined,
      technician: formData.technician || undefined,
      status: 'pending',
      createdAt: new Date().toISOString().split('T')[0],
      createdById: user?.id,
      createdByName: profile?.full_name || user?.email?.split('@')[0] || undefined,
    };

    setRequests([newRequest, ...requests]);
    void syncServiceToCloud(newRequest);
    setShowAddDialog(false);
    resetForm();
    toast.success(t('services.requestAdded'));
  };

  const handleEditRequest = () => {
    if (!selectedRequest || !formData.customerName) {
      toast.error(t('services.fillAllFields'));
      return;
    }

    const deviceLabel = deviceTypes.find(d => d.key === formData.deviceType)?.label || formData.deviceType;

    setRequests(requests.map(r =>
      r.id === selectedRequest.id
        ? {
          ...r,
          customerName: formData.customerName,
          customerPhone: formData.customerPhone,
          deviceType: deviceLabel,
          deviceModel: formData.deviceModel,
          issue: formData.issue,
          diagnosis: formData.diagnosis || undefined,
          estimatedCost: formData.estimatedCost || undefined,
          estimatedDate: formData.estimatedDate || undefined,
          notes: formData.notes || undefined,
          technician: formData.technician || undefined,
        }
        : r
    ));
    const updatedReq: RepairRequest = {
      ...selectedRequest,
      customerName: formData.customerName,
      customerPhone: formData.customerPhone,
      deviceType: deviceLabel,
      deviceModel: formData.deviceModel,
      issue: formData.issue,
      diagnosis: formData.diagnosis || undefined,
      estimatedCost: formData.estimatedCost || undefined,
      estimatedDate: formData.estimatedDate || undefined,
      notes: formData.notes || undefined,
      technician: formData.technician || undefined,
    };
    void syncServiceToCloud(updatedReq);
    setShowEditDialog(false);
    setSelectedRequest(null);
    resetForm();
    toast.success(t('services.requestUpdated'));
  };

  const handleRefundRequest = () => {
    if (!selectedRequest) return;

    const updatedRefund: RepairRequest = { ...selectedRequest, status: 'refunded' as const };
    setRequests(requests.map(r =>
      r.id === selectedRequest.id ? updatedRefund : r
    ));
    void syncServiceToCloud(updatedRefund);
    setShowDeleteDialog(false);
    setSelectedRequest(null);
    toast.success('تم استرداد الطلب بنجاح');
  };

  const handleUpdateStatus = (request: RepairRequest, newStatus: RepairRequest['status']) => {
    // If status is being changed to delivered, open delivery dialog
    if (newStatus === 'delivered') {
      setSelectedRequest(request);
      setDeliveryData({
        partsCost: 0,
        amountReceived: request.estimatedCost || 0,
        paymentType: 'cash',
      });
      setShowDeliveryDialog(true);
      return;
    }

    const updates: Partial<RepairRequest> = { status: newStatus };

    if (newStatus === 'completed') {
      updates.completedAt = new Date().toISOString().split('T')[0];
    }

    const updatedStatusReq: RepairRequest = { ...request, ...updates };
    setRequests(requests.map(r =>
      r.id === request.id ? updatedStatusReq : r
    ));
    void syncServiceToCloud(updatedStatusReq);
    toast.success(t('services.statusUpdated').replace('{status}', statusConfig[newStatus].label));
  };

  const handleDeliveryConfirm = () => {
    if (!selectedRequest) return;

    const profit = deliveryData.amountReceived - deliveryData.partsCost;

    const updates: Partial<RepairRequest> = {
      status: 'delivered',
      partsCost: deliveryData.partsCost,
      amountReceived: deliveryData.amountReceived,
      profit,
      paymentType: deliveryData.paymentType,
      deliveredAt: new Date().toISOString().split('T')[0],
      finalCost: deliveryData.amountReceived,
    };

    const updatedDeliveryReq: RepairRequest = { ...selectedRequest, ...updates };
    setRequests(requests.map(r =>
      r.id === selectedRequest.id ? updatedDeliveryReq : r
    ));
    void syncServiceToCloud(updatedDeliveryReq);

    setShowDeliveryDialog(false);
    setSelectedRequest(null);

    if (deliveryData.paymentType === 'debt') {
      toast.success(t('services.deliveredDebt').replace('${profit}', String(profit)));
    } else {
      toast.success(t('services.deliveredCash').replace('${profit}', String(profit)));
    }
  };

  const openEditDialog = (request: RepairRequest) => {
    setSelectedRequest(request);
    setFormData({
      customerName: request.customerName,
      customerPhone: request.customerPhone,
      deviceType: request.deviceType,
      deviceModel: request.deviceModel,
      issue: request.issue,
      diagnosis: request.diagnosis || '',
      estimatedCost: request.estimatedCost || 0,
      estimatedDate: request.estimatedDate || '',
      notes: request.notes || '',
      technician: request.technician || '',
    });
    setShowEditDialog(true);
  };

  const openViewDialog = (request: RepairRequest) => {
    setSelectedRequest(request);
    setShowViewDialog(true);
  };

  const openDeleteDialog = (request: RepairRequest) => {
    setSelectedRequest(request);
    setShowDeleteDialog(true);
  };

  if (activeView !== 'list') {
    const isEdit = activeView === 'edit';
    return (
      <div
        className="min-h-[100dvh] bg-background flex flex-col pb-24 animate-in fade-in-50 duration-150 relative"
        dir={isRTL ? 'rtl' : 'ltr'}
      >
        {/* الترويسة العلوية الثابتة مع مراعاة زر القائمة الجانبية للموبايل */}
        <div className="sticky top-0 z-40 bg-card border-b border-border/80 px-4 py-3 ps-14 md:ps-6 flex items-center justify-between shadow-xs">
          <div className="flex items-center gap-2.5">
            <div className="size-10 rounded-[14px] bg-primary/10 border border-primary/20 text-primary flex items-center justify-center shrink-0">
              {isEdit ? <Edit className="w-4 h-4" /> : <Wrench className="w-4 h-4" />}
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-foreground tracking-tight">
                {isEdit ? t('services.editRequest') : t('services.addNewRequest')}
              </h2>
              <p className="text-xs text-muted-foreground">
                {isEdit ? 'تحديث بيانات وتشخيص طلب الصيانة' : t('services.addNewRequestDesc')}
              </p>
            </div>
          </div>
        </div>

        {/* جسم النموذج الكامل المتجاوب */}
        <div className="flex-1 max-w-4xl w-full mx-auto p-4 sm:p-6 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-card p-4 sm:p-6 rounded-2xl border border-border shadow-2xs">
            <div>
              <label className="text-sm font-medium mb-1.5 block">{t('services.customerName')} *</label>
              <Input
                placeholder={t('services.customerNamePlaceholder')}
                value={formData.customerName}
                onChange={(e) => setFormData({ ...formData, customerName: e.target.value })}
                className="h-11 rounded-xl"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">{t('services.phoneNumber')} *</label>
              <Input
                placeholder={t('services.phonePlaceholder')}
                value={formData.customerPhone}
                onChange={(e) => setFormData({ ...formData, customerPhone: e.target.value })}
                className="h-11 rounded-xl"
                dir="ltr"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="text-sm font-medium mb-1.5 block">{t('services.deviceType')}</label>
              <div className="flex flex-wrap gap-2">
                {deviceTypes.map(type => (
                  <button
                    key={type.key}
                    type="button"
                    onClick={() => setFormData({ ...formData, deviceType: type.key })}
                    className={cn(
                      "rounded-full h-10 px-4 text-xs font-bold transition-all duration-200 cursor-pointer select-none",
                      formData.deviceType === type.key
                        ? "bg-primary text-primary-foreground shadow-xs scale-105"
                        : "bg-muted text-foreground hover:bg-muted/80"
                    )}
                  >
                    {type.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="sm:col-span-2">
              <label className="text-sm font-medium mb-1.5 block">{t('services.deviceModel')} *</label>
              <Input
                placeholder={t('services.deviceModelPlaceholder')}
                value={formData.deviceModel}
                onChange={(e) => setFormData({ ...formData, deviceModel: e.target.value })}
                className="h-11 rounded-xl"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="text-sm font-medium mb-1.5 block">{t('services.issue')} *</label>
              <Input
                placeholder={t('services.issuePlaceholder')}
                value={formData.issue}
                onChange={(e) => setFormData({ ...formData, issue: e.target.value })}
                className="h-11 rounded-xl"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="text-sm font-medium mb-1.5 block">
                {isEdit ? t('services.diagnosis') : t('services.initialDiagnosis')}
              </label>
              <Input
                placeholder={t('services.initialDiagnosisPlaceholder')}
                value={formData.diagnosis}
                onChange={(e) => setFormData({ ...formData, diagnosis: e.target.value })}
                className="h-11 rounded-xl"
              />
            </div>

            <div>
              <label className="text-sm font-medium mb-1.5 block">{t('services.expectedCostLabel')}</label>
              <Input
                type="number"
                dir="ltr"
                placeholder="0"
                value={formData.estimatedCost || ''}
                onChange={(e) => setFormData({ ...formData, estimatedCost: Number(e.target.value) })}
                className="h-11 rounded-xl font-mono tabular-nums"
              />
            </div>

            <div>
              <label className="text-sm font-medium mb-1.5 block">{t('services.expectedDelivery')}</label>
              <DatePicker
                value={formData.estimatedDate}
                onChange={(date) => setFormData({ ...formData, estimatedDate: date })}
                placeholder={t('services.selectDeliveryDate')}
              />
            </div>

            <div>
              <label className="text-sm font-medium mb-1.5 block">{t('services.responsibleTech')}</label>
              <Input
                placeholder={t('services.techNamePlaceholder')}
                value={formData.technician}
                onChange={(e) => setFormData({ ...formData, technician: e.target.value })}
                className="h-11 rounded-xl"
              />
            </div>

            <div>
              <label className="text-sm font-medium mb-1.5 block">{t('services.notes')}</label>
              <Input
                placeholder={t('services.notesPlaceholder')}
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                className="h-11 rounded-xl"
              />
            </div>
          </div>
        </div>

        {/* شريط الإجراءات السفلي الثابت */}
        <div className="sticky bottom-0 z-40 bg-card border-t border-border/80 p-3 sm:px-6 flex items-center gap-3 max-w-4xl w-full mx-auto shadow-lg">
          <Button
            type="button"
            variant="outline"
            size="default"
            disabled={isSaving}
            className="flex-1"
            onClick={() => {
              setActiveView('list');
              setSelectedRequest(null);
            }}
          >
            {t('services.cancel')}
          </Button>
          <Button
            type="button"
            variant="default"
            size="default"
            disabled={isSaving}
            className="flex-[2]"
            onClick={() => {
              setIsSaving(true);
              try {
                if (isEdit) handleEditRequest();
                else handleAddRequest();
              } finally {
                setIsSaving(false);
              }
            }}
          >
            {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            <span>{isEdit ? t('services.saveChanges') : t('services.addRequest')}</span>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-3 sm:p-4 md:p-6 space-y-4 md:space-y-6">
      <PageHeader
        title={t('services.title') || 'إدارة الصيانة'}
        icon={<Wrench className="w-5 h-5" />}
        actions={
          <Button
            variant="default"
            size="default"
            onClick={() => { resetForm(); setShowAddDialog(true); }}
          >
            <Plus className="w-4 h-4 shrink-0" />
            <span>{t('services.newRequest')}</span>
          </Button>
        }
      />

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-2">
        {filterOptions.map((filter) => {
          const isSelected = selectedFilter === filter.key;
          return (
            <Button
              key={filter.key}
              type="button"
              size="sm"
              variant={isSelected ? "default" : "outline"}
              className="rounded-xl"
              onClick={() => setSelectedFilter(filter.key)}
            >
              {filter.label}
            </Button>
          );
        })}
      </div>

      {/* Compact Stats Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 text-center select-none">
        <div className="bg-card py-3 px-2 rounded-xl border border-border shadow-xs">
          <span className="text-xs text-muted-foreground font-medium block truncate">{t('services.totalRequests')}</span>
          <span dir="ltr" className="inline-block text-base font-bold text-foreground tabular-nums mt-0.5">{stats.total}</span>
        </div>
        <div className="bg-card py-3 px-2 rounded-xl border border-border shadow-xs">
          <span className="text-xs text-warning font-medium block truncate">{t('services.pending')}</span>
          <span dir="ltr" className="inline-block text-base font-bold text-warning tabular-nums mt-0.5">{stats.pending}</span>
        </div>
        <div className="bg-card py-3 px-2 rounded-xl border border-border shadow-xs">
          <span className="text-xs text-info font-medium block truncate">{t('services.inProgress')}</span>
          <span dir="ltr" className="inline-block text-base font-bold text-info tabular-nums mt-0.5">{stats.inProgress}</span>
        </div>
        <div className="bg-card py-3 px-2 rounded-xl border border-border shadow-xs">
          <span className="text-xs text-success font-medium block truncate">{t('services.completed')}</span>
          <span dir="ltr" className="inline-block text-base font-bold text-success tabular-nums mt-0.5">{stats.completed}</span>
        </div>
      </div>

      {/* Search */}
      <div className="relative flex-1 min-w-0">
        <Search className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          type="text"
          placeholder={t('services.searchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="ps-9 pe-3"
        />
      </div>

      {/* Requests List */}
      {filteredRequests.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center py-10 px-4 rounded-2xl border border-dashed border-border/70 bg-muted/20">
          <Wrench className="w-12 h-12 text-muted-foreground/50 mb-3" />
          <p className="text-sm sm:text-base font-semibold text-foreground">{t('services.title') || 'إدارة الصيانة'}</p>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1 max-w-sm">
            {t('services.searchPlaceholder')}
          </p>
        </div>
      ) : (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
        {filteredRequests.map((request, index) => {
          const status = statusConfig[request.status];
          const StatusIcon = status.icon;

          return (
            <div
              key={request.id}
              className="bg-card rounded-xl md:rounded-2xl border border-border p-4 md:p-6 card-hover fade-in"
              style={{ animationDelay: `${index * 50}ms` }}
            >
              {/* Header */}
              <div className="flex items-start justify-between mb-3 md:mb-4">
                <div className="flex items-center gap-2 md:gap-3">
                  <div className="w-10 h-10 md:w-12 md:h-12 rounded-full bg-gradient-primary flex items-center justify-center">
                    <Smartphone className="w-5 h-5 md:w-6 md:h-6 text-primary-foreground" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-semibold text-foreground text-sm sm:text-base truncate">{request.customerName}</h3>
                    <p dir="ltr" className="inline-block text-xs text-muted-foreground font-mono tabular-nums truncate max-w-[12rem]">{request.id}</p>
                  </div>
                </div>
                <Badge variant="outline" className={cn("gap-1 shrink-0", status.color)}>
                  <StatusIcon className="w-3 h-3" />
                  {status.label}
                </Badge>
              </div>

              {/* Device Info */}
              <div className="space-y-2 mb-3 md:mb-4">
                <div className="flex items-center gap-2 text-xs md:text-sm">
                  <Smartphone className="w-3.5 h-3.5 md:w-4 md:h-4 text-muted-foreground shrink-0" />
                  <span className="text-foreground font-medium">{request.deviceType} - {request.deviceModel}</span>
                </div>
                <div className="flex items-center gap-2 text-xs md:text-sm text-muted-foreground">
                  <Phone className="w-3.5 h-3.5 md:w-4 md:h-4 shrink-0" />
                  <span dir="ltr" className="inline-block tabular-nums">{request.customerPhone}</span>
                </div>
                <div className="flex items-center flex-wrap gap-2 text-xs md:text-sm text-muted-foreground">
                  <Calendar className="w-3.5 h-3.5 md:w-4 md:h-4 shrink-0" />
                  <span dir="ltr" className="inline-block tabular-nums">{request.createdAt}</span>
                  {request.createdByName && (
                    <Badge variant="secondary" className="gap-1 font-normal">
                      <User className="w-3 h-3" />
                      {request.createdByName}
                    </Badge>
                  )}
                </div>
              </div>

              {/* Issue */}
              <div className="p-3 bg-muted rounded-lg mb-3 md:mb-4">
                <p className="text-xs text-muted-foreground mb-1">{t('services.issue')}:</p>
                <p className="text-sm font-medium text-foreground">{request.issue}</p>
              </div>

              {/* Cost - For non-delivered */}
              {request.status !== 'delivered' && (request.estimatedCost || request.finalCost) && (
                <div className="flex items-center justify-between mb-3 md:mb-4 p-2.5 bg-primary/10 rounded-lg">
                  <span className="text-xs md:text-sm text-muted-foreground">
                    {request.finalCost ? t('services.finalCost') : t('services.expectedCost')}
                  </span>
                  <span dir="ltr" className="inline-block font-bold text-primary tabular-nums">
                    ${request.finalCost || request.estimatedCost}
                  </span>
                </div>
              )}

              {/* Financial info for delivered services */}
              {request.status === 'delivered' && request.amountReceived !== undefined && (
                <div className="p-3 bg-success/10 rounded-lg space-y-2 mb-3 md:mb-4">
                  <div className="flex justify-between text-xs md:text-sm">
                    <span className="text-muted-foreground">{t('services.amountReceived')}:</span>
                    <span dir="ltr" className="inline-block font-bold text-success tabular-nums">${request.amountReceived}</span>
                  </div>
                  <div className="flex justify-between text-xs md:text-sm">
                    <span className="text-muted-foreground">{t('services.ourCost')}:</span>
                    <span dir="ltr" className="inline-block text-destructive tabular-nums">-${request.partsCost || 0}</span>
                  </div>
                  <div className="flex justify-between text-xs md:text-sm border-t border-border pt-2">
                    <span className="font-medium">{t('services.netProfit')}:</span>
                    <span dir="ltr" className="inline-block font-bold text-primary tabular-nums">${request.profit || 0}</span>
                  </div>
                  {request.paymentType === 'debt' && (
                    <div className="flex items-center gap-1 text-xs text-warning">
                      <DollarSign className="w-3 h-3" />
                      <span>{t('services.debt')}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Quick Status Update */}
              {request.status !== 'delivered' && request.status !== 'cancelled' && (
                <div className="flex gap-1.5 mb-3 md:mb-4 overflow-x-auto pb-1">
                  {request.status === 'pending' && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs min-h-10 sm:min-h-9"
                      onClick={() => handleUpdateStatus(request, 'in_progress')}
                    >
                      {t('services.startRepair')}
                    </Button>
                  )}
                  {request.status === 'in_progress' && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-xs min-h-10 sm:min-h-9"
                        onClick={() => handleUpdateStatus(request, 'waiting_parts')}
                      >
                        {t('services.waitingForParts')}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-xs min-h-10 sm:min-h-9 bg-success/10 text-success border-success/30 hover:bg-success/15"
                        onClick={() => handleUpdateStatus(request, 'completed')}
                      >
                        {t('services.markCompleted')}
                      </Button>
                    </>
                  )}
                  {request.status === 'waiting_parts' && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs min-h-10 sm:min-h-9"
                      onClick={() => handleUpdateStatus(request, 'in_progress')}
                    >
                      {t('services.resumeRepair')}
                    </Button>
                  )}
                  {request.status === 'completed' && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs min-h-10 sm:min-h-9 bg-success/10 text-success border-success/30 hover:bg-success/15"
                      onClick={() => handleUpdateStatus(request, 'delivered')}
                    >
                      {t('services.markDelivered')}
                    </Button>
                  )}
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center gap-2 pt-3 border-t border-border">
                <Button variant="outline" size="sm" className="flex-1 min-h-11 sm:min-h-10 text-xs md:text-sm" onClick={() => openViewDialog(request)}>
                  <Eye className="w-4 h-4" />
                  {t('services.view')}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('services.editRequest')}
                  onClick={() => openEditDialog(request)}
                >
                  <Edit className="w-4 h-4" />
                </Button>
                {request.status !== 'refunded' && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-warning hover:text-warning hover:bg-warning/10"
                    aria-label="استرداد طلب الصيانة"
                    onClick={() => openDeleteDialog(request)}
                  >
                    <Undo2 className="w-4 h-4" />
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      )}

      {/* View Request Dialog */}
      <Dialog open={showViewDialog} onOpenChange={setShowViewDialog}>
        <DialogContent className="w-[min(calc(100vw-1.5rem),32rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px]">
          <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 text-start pe-12">
            <DialogTitle className="flex items-center gap-2">
              <Wrench className="w-5 h-5 text-primary shrink-0" />
              تفاصيل طلب الصيانة
            </DialogTitle>
          </DialogHeader>
          {selectedRequest && (
            <>
              <DialogBody className="space-y-4">
                {/* Customer Info */}
                <div className="flex items-center gap-4">
                  <div className="w-14 h-14 rounded-full bg-gradient-primary flex items-center justify-center shrink-0">
                    <Smartphone className="w-7 h-7 text-primary-foreground" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-sm sm:text-base font-semibold text-foreground truncate">{selectedRequest.customerName}</h3>
                    <p dir="ltr" className="inline-block text-sm text-muted-foreground tabular-nums">{selectedRequest.customerPhone}</p>
                    <p dir="ltr" className="block text-xs font-mono text-muted-foreground tabular-nums truncate">{selectedRequest.id}</p>
                  </div>
                </div>

                {/* Status */}
                <div className="flex justify-center">
                  <Badge variant="outline" className={cn("gap-1.5 px-3 py-1 text-xs", statusConfig[selectedRequest.status].color)}>
                    {(() => {
                      const StatusIcon = statusConfig[selectedRequest.status].icon;
                      return <StatusIcon className="w-3.5 h-3.5" />;
                    })()}
                    {statusConfig[selectedRequest.status].label}
                  </Badge>
                </div>

                {/* Device & Issue */}
                <div className="bg-muted rounded-xl p-4 space-y-3 text-sm">
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">الجهاز:</span>
                    <span className="font-medium">{selectedRequest.deviceType} - {selectedRequest.deviceModel}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">المشكلة:</span>
                    <span className="font-medium">{selectedRequest.issue}</span>
                  </div>
                  {selectedRequest.diagnosis && (
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground">التشخيص:</span>
                      <span className="font-medium">{selectedRequest.diagnosis}</span>
                    </div>
                  )}
                  {selectedRequest.technician && (
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground">الفني:</span>
                      <span className="font-medium">{selectedRequest.technician}</span>
                    </div>
                  )}
                </div>

                {/* Dates */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-muted rounded-xl p-3 text-center">
                    <p className="text-xs text-muted-foreground mb-1">تاريخ الاستلام</p>
                    <p dir="ltr" className="inline-block font-medium tabular-nums">{selectedRequest.createdAt}</p>
                  </div>
                  <div className="bg-muted rounded-xl p-3 text-center">
                    <p className="text-xs text-muted-foreground mb-1">
                      {selectedRequest.completedAt ? t('services.completionDate') : t('services.expectedDelivery')}
                    </p>
                    <p dir="ltr" className="inline-block font-medium tabular-nums">
                      {selectedRequest.completedAt || selectedRequest.estimatedDate || '-'}
                    </p>
                  </div>
                </div>

                {/* Cost */}
                {(selectedRequest.estimatedCost || selectedRequest.finalCost) && (
                  <div className="grid grid-cols-2 gap-3">
                    {selectedRequest.estimatedCost && (
                      <div className="bg-warning/10 rounded-xl p-3 text-center">
                        <p className="text-xs text-muted-foreground mb-1">التكلفة المتوقعة</p>
                        <p dir="ltr" className="inline-block font-bold text-warning tabular-nums">${selectedRequest.estimatedCost}</p>
                      </div>
                    )}
                    {selectedRequest.finalCost && (
                      <div className="bg-success/10 rounded-xl p-3 text-center">
                        <p className="text-xs text-muted-foreground mb-1">التكلفة النهائية</p>
                        <p dir="ltr" className="inline-block font-bold text-success tabular-nums">${selectedRequest.finalCost}</p>
                      </div>
                    )}
                  </div>
                )}

                {selectedRequest.notes && (
                  <div className="bg-muted/50 rounded-xl p-3">
                    <p className="text-xs text-muted-foreground mb-1">ملاحظات:</p>
                    <p className="text-sm">{selectedRequest.notes}</p>
                  </div>
                )}
              </DialogBody>

              {/* Actions */}
              <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 border-t border-border/60">
                <Button variant="outline" size="default" onClick={() => {
                  setShowViewDialog(false);
                  openEditDialog(selectedRequest);
                }}>
                  <Edit className="w-4 h-4" />
                  تعديل
                </Button>
                {selectedRequest.status !== 'cancelled' && selectedRequest.status !== 'delivered' && (
                  <Button
                    variant="destructive"
                    size="default"
                    onClick={() => {
                      handleUpdateStatus(selectedRequest, 'cancelled');
                      setShowViewDialog(false);
                    }}
                  >
                    <XCircle className="w-4 h-4" />
                    إلغاء الطلب
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Refund Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-warning">
              <Undo2 className="w-5 h-5" />
              استرداد طلب الصيانة
            </AlertDialogTitle>
            <AlertDialogDescription>
              سيتم تحديد طلب الصيانة "<span dir="ltr" className="inline-block font-mono tabular-nums">{selectedRequest?.id}</span>" كمسترجع. سيبقى في السجلات لأغراض التدقيق.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction onClick={handleRefundRequest} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              تأكيد الاسترداد
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delivery Dialog */}
      <Dialog open={showDeliveryDialog} onOpenChange={setShowDeliveryDialog}>
        <DialogContent
          className="w-[min(calc(100vw-1.5rem),32rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px]"
          onPointerDownOutside={(e) => { if (deliveryData.partsCost > 0 || deliveryData.amountReceived > 0) e.preventDefault(); }}
          onEscapeKeyDown={(e) => { if (deliveryData.partsCost > 0 || deliveryData.amountReceived > 0) e.preventDefault(); }}
        >
          <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 text-start pe-12">
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle className="w-5 h-5 text-success shrink-0" />
              تسليم طلب الصيانة
            </DialogTitle>
            <DialogDescription>
              أدخل تفاصيل التسليم والمبالغ المالية
            </DialogDescription>
          </DialogHeader>
          {selectedRequest && (
            <>
              <DialogBody className="space-y-4">
                {/* Customer & Device Info */}
                <div className="bg-muted rounded-xl p-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-gradient-primary flex items-center justify-center shrink-0">
                      <User className="w-5 h-5 text-primary-foreground" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-foreground truncate">{selectedRequest.customerName}</p>
                      <p className="text-sm text-muted-foreground truncate">{selectedRequest.deviceType} - {selectedRequest.deviceModel}</p>
                    </div>
                  </div>
                </div>

                {/* Financial Inputs */}
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium block">التكلفة علينا (القطع) ($)</label>
                    <Input
                      type="number"
                      dir="ltr"
                      placeholder="0"
                      value={deliveryData.partsCost || ''}
                      onChange={(e) => setDeliveryData({ ...deliveryData, partsCost: Number(e.target.value) })}
                      className="text-lg tabular-nums"
                    />
                    <p className="text-xs text-muted-foreground">تكلفة القطع والمواد المستخدمة</p>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-sm font-medium block">المبلغ المقبوض من العميل ($)</label>
                    <Input
                      type="number"
                      dir="ltr"
                      placeholder="0"
                      value={deliveryData.amountReceived || ''}
                      onChange={(e) => setDeliveryData({ ...deliveryData, amountReceived: Number(e.target.value) })}
                      className="text-lg tabular-nums"
                    />
                  </div>

                  {/* Calculated Profit */}
                  <div className="bg-success/10 rounded-xl p-4">
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-medium text-foreground">الربح الصافي:</span>
                      <span dir="ltr" className={cn(
                        "inline-block text-2xl font-bold tabular-nums",
                        (deliveryData.amountReceived - deliveryData.partsCost) >= 0
                          ? "text-success"
                          : "text-destructive"
                      )}>
                        ${deliveryData.amountReceived - deliveryData.partsCost}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">المبلغ المقبوض - التكلفة علينا</p>
                  </div>

                  {/* Payment Type */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium block">نوع الدفع</label>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant={deliveryData.paymentType === 'cash' ? 'default' : 'outline'}
                        className="rounded-xl min-h-11 sm:min-h-10"
                        onClick={() => setDeliveryData({ ...deliveryData, paymentType: 'cash' })}
                      >
                        <DollarSign className="w-4 h-4" />
                        <span>نقدي</span>
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={deliveryData.paymentType === 'debt' ? 'default' : 'outline'}
                        className="rounded-xl min-h-11 sm:min-h-10"
                        onClick={() => setDeliveryData({ ...deliveryData, paymentType: 'debt' })}
                      >
                        <Clock className="w-4 h-4" />
                        <span>دين</span>
                      </Button>
                    </div>
                  </div>
                </div>
              </DialogBody>

              {/* Actions */}
              <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 border-t border-border/60">
                <Button variant="outline" size="default" onClick={() => setShowDeliveryDialog(false)}>
                  إلغاء
                </Button>
                <Button
                  variant="default"
                  size="default"
                  onClick={handleDeliveryConfirm}
                  disabled={deliveryData.amountReceived <= 0}
                >
                  <CheckCircle className="w-4 h-4" />
                  تأكيد التسليم
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
