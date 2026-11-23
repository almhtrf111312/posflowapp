import { useState } from 'react';
import { Calendar, Search, Filter, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/hooks/use-language';
import { getDatePresetRange } from '@/lib/date-utils';

export interface ReportFilters {
  dateRange: { from: string; to: string };
  search: string;
  status: string;
  cashierId: string;
  warehouseId: string;
  category: string;
  paymentType: string;
}

interface FilterConfig {
  showStatus?: boolean;
  showCashier?: boolean;
  showWarehouse?: boolean;
  showCategory?: boolean;
  showPaymentType?: boolean;
  showSearch?: boolean;
  statusOptions?: { value: string; label: string }[];
  cashiers?: { id: string; name: string }[];
  warehouses?: { id: string; name: string }[];
  categories?: { id: string; name: string }[];
}

interface Props {
  filters: ReportFilters;
  onChange: (filters: ReportFilters) => void;
  config: FilterConfig;
}

export function ReportFiltersBar({ filters, onChange, config }: Props) {
  const { t, isRTL, language } = useLanguage();
  const [showCustomDate, setShowCustomDate] = useState(false);

  const datePresets = [
    { label: t('reports.today') || 'اليوم', getValue: () => getDatePresetRange('today') },
    { label: t('reports.yesterday') || 'أمس', getValue: () => getDatePresetRange('yesterday') },
    { label: t('reports.thisWeek') || 'هذا الأسبوع', getValue: () => getDatePresetRange('week') },
    { label: t('reports.thisMonth') || 'هذا الشهر', getValue: () => getDatePresetRange('month') },
    { label: t('reports.last30Days') || 'آخر 30 يوم', getValue: () => getDatePresetRange('last30') },
  ];

  const update = (partial: Partial<ReportFilters>) => {
    onChange({ ...filters, ...partial });
  };

  const hasActiveFilters = filters.search || filters.status !== 'all' || filters.cashierId !== 'all' || filters.warehouseId !== 'all' || filters.category !== 'all' || filters.paymentType !== 'all';

  const clearFilters = () => {
    onChange({
      ...filters,
      search: '',
      status: 'all',
      cashierId: 'all',
      warehouseId: 'all',
      category: 'all',
      paymentType: 'all',
    });
  };

  return (
    <div className="space-y-3">
      {/* Date presets row */}
      <div className="flex flex-wrap gap-1.5">
        {datePresets.map((preset) => {
          const presetValue = preset.getValue();
          const isActive = filters.dateRange.from === presetValue.from && filters.dateRange.to === presetValue.to;
          return (
            <button
              key={preset.label}
              onClick={() => {
                update({ dateRange: presetValue });
                setShowCustomDate(false);
              }}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-medium transition-all border",
                isActive
                  ? "bg-primary text-primary-foreground border-primary/30 shadow-sm"
                  : "bg-card text-muted-foreground hover:text-foreground hover:bg-muted border-border/50"
              )}
            >
              {preset.label}
            </button>
          );
        })}
        <button
          onClick={() => setShowCustomDate(!showCustomDate)}
          className={cn(
            "px-3 py-1.5 rounded-lg text-xs font-medium transition-all border flex items-center gap-1",
            showCustomDate
              ? "bg-primary text-primary-foreground border-primary/30 shadow-sm"
              : "bg-card text-muted-foreground hover:text-foreground hover:bg-muted border-border/50"
          )}
        >
          <Calendar className="w-3 h-3" />
          {t('reports.custom') || 'مخصص'}
        </button>
      </div>

      {/* Custom date inputs */}
      {showCustomDate && (
        <div className="flex flex-wrap gap-2">
          <div className="flex items-center gap-1.5 bg-card rounded-lg border border-border/50 px-2.5 py-1.5">
            <span className="text-xs text-muted-foreground">{t('reports.from') || 'من'}:</span>
            <Input
              type="date"
              value={filters.dateRange.from}
              onChange={(e) => update({ dateRange: { ...filters.dateRange, from: e.target.value } })}
              className="min-h-10 text-xs border-0 bg-transparent p-0 w-32 focus-visible:ring-0"
            />
          </div>
          <div className="flex items-center gap-1.5 bg-card rounded-lg border border-border/50 px-2.5 py-1.5">
            <span className="text-xs text-muted-foreground">{t('reports.to') || 'إلى'}:</span>
            <Input
              type="date"
              value={filters.dateRange.to}
              onChange={(e) => update({ dateRange: { ...filters.dateRange, to: e.target.value } })}
              className="min-h-10 text-xs border-0 bg-transparent p-0 w-32 focus-visible:ring-0"
            />
          </div>
        </div>
      )}

      {/* Contextual filters row */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Search */}
        {config.showSearch !== false && (
          <div className="relative flex-1 min-w-48 w-full sm:max-w-xs">
            <Search className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder={t('reports.searchPlaceholder') || 'ابحث بالاسم أو الرقم أو الباركود...'}
              value={filters.search}
              onChange={(e) => update({ search: e.target.value })}
              className="min-h-11 sm:min-h-10 text-sm rounded-[14px] ps-9 pe-9"
            />
            {filters.search && (
              <button
                type="button"
                aria-label={t('common.clear') || 'مسح البحث'}
                onClick={() => update({ search: '' })}
                className="absolute top-1/2 -translate-y-1/2 end-2 size-9 flex items-center justify-center text-muted-foreground hover:text-foreground z-10 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        )}

        {/* Status filter */}
        {config.showStatus && (
          <Select value={filters.status} onValueChange={(v) => update({ status: v })}>
            <SelectTrigger className="min-h-11 sm:min-h-10 text-xs w-full sm:w-40 rounded-[14px]">
              <SelectValue placeholder={t('common.status') || 'الحالة'} />
            </SelectTrigger>
            <SelectContent className="max-h-[min(20rem,60dvh)] overflow-y-auto">
              <SelectItem value="all">{t('reports.allStatuses') || 'كل الحالات'}</SelectItem>
              {(config.statusOptions || [
                { value: 'completed', label: t('reports.statusCompleted') || 'مكتملة' },
                { value: 'refunded', label: t('reports.statusRefunded') || 'مرتجعة' },
                { value: 'cancelled', label: t('reports.statusCancelled') || 'ملغاة' },
              ]).map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Cashier filter */}
        {config.showCashier && config.cashiers && config.cashiers.length > 0 && (
          <Select value={filters.cashierId} onValueChange={(v) => update({ cashierId: v })}>
            <SelectTrigger className="min-h-11 sm:min-h-10 text-xs w-full sm:w-44 rounded-[14px]">
              <SelectValue placeholder={t('cashShifts.cashier') || 'الكاشير'} />
            </SelectTrigger>
            <SelectContent className="max-h-[min(20rem,60dvh)] overflow-y-auto">
              <SelectItem value="all">{t('reports.filterAllCashiers') || 'جميع الكاشيرات'}</SelectItem>
              {config.cashiers.map((c) => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Warehouse filter */}
        {config.showWarehouse && config.warehouses && config.warehouses.length > 0 && (
          <Select value={filters.warehouseId} onValueChange={(v) => update({ warehouseId: v })}>
            <SelectTrigger className="min-h-11 sm:min-h-10 text-xs w-full sm:w-44 rounded-[14px]">
              <SelectValue placeholder={t('reports.warehouse') || 'المستودع'} />
            </SelectTrigger>
            <SelectContent className="max-h-[min(20rem,60dvh)] overflow-y-auto">
              <SelectItem value="all">{t('reports.allWarehouses') || 'جميع المستودعات'}</SelectItem>
              {config.warehouses.map((w) => (
                <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Category filter */}
        {config.showCategory && config.categories && config.categories.length > 0 && (
          <Select value={filters.category} onValueChange={(v) => update({ category: v })}>
            <SelectTrigger className="min-h-11 sm:min-h-10 text-xs w-full sm:w-44 rounded-[14px]">
              <SelectValue placeholder={t('products.category') || 'القسم'} />
            </SelectTrigger>
            <SelectContent className="max-h-[min(20rem,60dvh)] overflow-y-auto">
              <SelectItem value="all">{t('reports.filterAllCategories') || 'جميع الأقسام'}</SelectItem>
              {config.categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Payment type filter */}
        {config.showPaymentType && (
          <Select value={filters.paymentType} onValueChange={(v) => update({ paymentType: v })}>
            <SelectTrigger className="min-h-11 sm:min-h-10 text-xs w-full sm:w-36 rounded-[14px]">
              <SelectValue placeholder={t('reports.paymentType') || 'نوع الدفع'} />
            </SelectTrigger>
            <SelectContent className="max-h-[min(20rem,60dvh)] overflow-y-auto">
              <SelectItem value="all">{t('common.all') || 'الكل'}</SelectItem>
              <SelectItem value="cash">{t('pos.cash') || 'نقدي'}</SelectItem>
              <SelectItem value="debt">{t('pos.debt') || 'آجل'}</SelectItem>
            </SelectContent>
          </Select>
        )}

        {/* Clear filters */}
        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters} className="text-xs gap-1 text-muted-foreground">
            <X className="w-3 h-3" />
            {t('reports.clearFilters') || 'مسح الفلاتر'}
          </Button>
        )}
      </div>
    </div>
  );
}
