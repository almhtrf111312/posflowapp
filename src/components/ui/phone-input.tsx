/**
 * حقل رقم هاتف بكود الدولة: قائمة منسدلة (علم + اسم + رمز) مع بحث، ثم الرقم المحلي.
 * القيمة الناتجة دائماً بالشكل الدولي: +<الرمز><الرقم بدون صفر البداية> (أو '' إذا كان الرقم فارغاً).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { COUNTRY_DIAL_CODES } from '@/lib/country-dial-codes';
import { cn } from '@/lib/utils';

const PINNED = ['SY', 'TR', 'SA', 'IQ', 'LB', 'JO', 'EG', 'AE', 'KW', 'QA', 'DE'];
const DEFAULT_ISO = 'SY';

/** علم سوريا الجديد (أخضر/أبيض/أسود وثلاث نجوم حمراء) — مرسوم محلياً لأن مصادر الأعلام قد تعرض الشكل القديم */
function SyriaFlag({ className }: { className?: string }) {
  const star = (cx: number, cy: number, r: number) => {
    const pts: string[] = [];
    for (let i = 0; i < 10; i++) {
      const ang = (-90 + i * 36) * (Math.PI / 180);
      const rad = i % 2 === 0 ? r : r * 0.4;
      pts.push(`${(cx + rad * Math.cos(ang)).toFixed(2)},${(cy + rad * Math.sin(ang)).toFixed(2)}`);
    }
    return pts.join(' ');
  };
  return (
    <svg viewBox="0 0 30 20" className={className} aria-label="Syria" role="img">
      <rect width="30" height="6.67" y="0" fill="#007A3D" />
      <rect width="30" height="6.67" y="6.67" fill="#FFFFFF" />
      <rect width="30" height="6.66" y="13.34" fill="#000000" />
      <polygon points={star(8, 10, 2.3)} fill="#CE1126" />
      <polygon points={star(15, 10, 2.3)} fill="#CE1126" />
      <polygon points={star(22, 10, 2.3)} fill="#CE1126" />
    </svg>
  );
}

function Flag({ iso, className }: { iso: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (iso === 'SY') return <SyriaFlag className={cn('w-6 h-4 rounded-[2px] shrink-0 border border-border/40', className)} />;
  if (failed) {
    return <span className={cn('w-6 h-4 shrink-0 rounded-[2px] bg-muted text-[8px] font-bold flex items-center justify-center', className)}>{iso}</span>;
  }
  return (
    <img
      src={`https://flagcdn.com/w40/${iso.toLowerCase()}.png`}
      alt={iso}
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn('w-6 h-4 object-cover rounded-[2px] shrink-0 border border-border/40', className)}
    />
  );
}

interface Country {
  iso: string;
  dial: string;
  name: string;
}

function useCountries(): Country[] {
  return useMemo(() => {
    const lang = (typeof document !== 'undefined' && document.documentElement.lang) || 'ar';
    let names: Intl.DisplayNames | null = null;
    try { names = new Intl.DisplayNames([lang, 'en'], { type: 'region' }); } catch { names = null; }
    const all: Country[] = COUNTRY_DIAL_CODES.map(([iso, dial]) => {
      let name = iso;
      try { name = names?.of(iso) || iso; } catch { /* ignore */ }
      return { iso, dial, name };
    });
    const pinned = PINNED.map((iso) => all.find((c) => c.iso === iso)).filter(Boolean) as Country[];
    const rest = all.filter((c) => !PINNED.includes(c.iso)).sort((a, b) => a.name.localeCompare(b.name, lang));
    return [...pinned, ...rest];
  }, []);
}

function defaultIso(): string {
  try {
    const region = (navigator.language || '').split('-')[1]?.toUpperCase();
    if (region && PINNED.includes(region)) return region;
  } catch { /* ignore */ }
  return DEFAULT_ISO;
}

function parseValue(value: string, countries: Country[], preferredIso: string): { iso: string; national: string } {
  const v = (value || '').trim();
  if (!v.startsWith('+')) return { iso: preferredIso, national: v.replace(/\D/g, '') };
  const digits = v.replace(/\D/g, '');
  const preferred = countries.find((c) => c.iso === preferredIso);
  if (preferred && digits.startsWith(preferred.dial)) return { iso: preferredIso, national: digits.slice(preferred.dial.length) };
  const match = [...countries].sort((a, b) => b.dial.length - a.dial.length).find((c) => digits.startsWith(c.dial));
  return match ? { iso: match.iso, national: digits.slice(match.dial.length) } : { iso: preferredIso, national: digits };
}

export interface PhoneInputProps {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
}

export function PhoneInput({ value, onChange, id, disabled, placeholder = '9XXXXXXXX', className, inputClassName }: PhoneInputProps) {
  const countries = useCountries();
  const [iso, setIso] = useState<string>(() => parseValue(value, countries, defaultIso()).iso);
  const [national, setNational] = useState<string>(() => parseValue(value, countries, defaultIso()).national);
  const [open, setOpen] = useState(false);
  const lastEmitted = useRef<string>(value);

  const country = countries.find((c) => c.iso === iso) || countries[0];

  // مزامنة عند تغيّر القيمة من الخارج (مثلاً تعبئة من السحابة)
  useEffect(() => {
    if (value === lastEmitted.current) return;
    const parsed = parseValue(value, countries, iso);
    setIso(parsed.iso);
    setNational(parsed.national);
    lastEmitted.current = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const emit = (nextIso: string, nextNational: string) => {
    const c = countries.find((x) => x.iso === nextIso) || country;
    const local = nextNational.replace(/\D/g, '').replace(/^0+/, '');
    const out = local ? `+${c.dial}${local}` : '';
    lastEmitted.current = out;
    onChange(out);
  };

  return (
    <div className={cn('flex gap-2', className)} dir="ltr">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className="h-10 shrink-0 flex items-center gap-1.5 rounded-xl border border-input bg-background px-2.5 text-sm hover:bg-muted/50 disabled:opacity-50"
            aria-label="اختيار رمز الدولة"
          >
            <Flag iso={country.iso} />
            <span className="font-mono text-xs font-bold">+{country.dial}</span>
            <ChevronDown className="w-3.5 h-3.5 opacity-60" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0 z-[10001]" align="start">
          <Command>
            <CommandInput placeholder="ابحث عن دولة أو رمز..." />
            <CommandList className="max-h-64">
              <CommandEmpty>لا توجد نتائج</CommandEmpty>
              {countries.map((c) => (
                <CommandItem
                  key={c.iso}
                  value={`${c.name} ${c.iso} +${c.dial}`}
                  onSelect={() => {
                    setIso(c.iso);
                    setOpen(false);
                    emit(c.iso, national);
                  }}
                  className="gap-2"
                >
                  <Flag iso={c.iso} />
                  <span className="flex-1 truncate text-start" dir="auto">{c.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">+{c.dial}</span>
                  {c.iso === iso && <Check className="w-4 h-4 text-primary" />}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <Input
        id={id}
        type="tel"
        inputMode="tel"
        dir="ltr"
        disabled={disabled}
        placeholder={placeholder}
        value={national}
        maxLength={15}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, '');
          setNational(digits);
          emit(iso, digits);
        }}
        className={cn('h-10 flex-1 min-w-0', inputClassName)}
      />
    </div>
  );
}
