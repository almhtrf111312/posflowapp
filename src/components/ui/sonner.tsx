import { useTheme } from "next-themes";
import { Toaster as Sonner, toast as sonnerToast } from "sonner";
import { useLanguage } from "@/hooks/use-language";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { showSmartToast, hideSmartToast, hideSmartToastById } from "@/hooks/use-smart-toast";
import { getSavedToastDuration } from "@/lib/toast-config";

type ToasterProps = React.ComponentProps<typeof Sonner>;

/**
 * Standardized POS Flow App Toast Component
 * Backward-compatible host for Sonner while all visual notifications
 * are rendered in-app via the unified SmartToastCard with swipe-to-dismiss.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();
  const { isRTL } = useLanguage();
  const isMobile = useIsMobile();
  const defaultDuration = getSavedToastDuration();

  const position = isMobile
    ? "top-center"
    : isRTL
    ? "bottom-left"
    : "bottom-right";

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      position={position}
      duration={defaultDuration}
      visibleToasts={3}
      closeButton={false}
      swipeDirections={isMobile ? ['left', 'right', 'top'] : ['left', 'right', 'bottom']}
      offset={isMobile ? 58 : 24}
      mobileOffset={58}
      dir={isRTL ? "rtl" : "ltr"}
      style={{
        '--width': 'auto',
        '--front-toast-width': 'auto'
      } as React.CSSProperties}
      toastOptions={{
        duration: defaultDuration,
        classNames: {
          toast: cn(
            "group toast w-auto min-w-0 max-w-[calc(100vw-1.5rem)] sm:min-w-[20rem] sm:max-w-[34rem]",
            "group-[.toaster]:bg-card group-[.toaster]:text-card-foreground",
            "group-[.toaster]:border group-[.toaster]:border-border/80 dark:group-[.toaster]:border-white/10",
            "group-[.toaster]:shadow-2xl group-[.toaster]:rounded-2xl",
            "group-[.toaster]:p-3.5 sm:group-[.toaster]:p-4 group-[.toaster]:text-sm sm:group-[.toaster]:text-base",
            "[touch-action:pan-x] cursor-grab active:cursor-grabbing",
            "transition-[transform,opacity] duration-200 select-none",
            isRTL
              ? "group-[.toaster]:border-r-[5px] group-[.toaster]:border-l"
              : "group-[.toaster]:border-l-[5px] group-[.toaster]:border-r"
          ),
          title: "group-[.toast]:font-bold group-[.toast]:text-card-foreground group-[.toast]:text-sm sm:group-[.toast]:text-base leading-snug break-words whitespace-normal",
          description: "group-[.toast]:text-muted-foreground group-[.toast]:text-xs sm:group-[.toast]:text-sm group-[.toast]:mt-1 leading-relaxed break-words whitespace-normal",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground group-[.toast]:rounded-xl group-[.toast]:text-xs group-[.toast]:font-semibold group-[.toast]:px-4 group-[.toast]:py-2 group-[.toast]:shadow-sm hover:opacity-90 transition-opacity",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground group-[.toast]:rounded-xl group-[.toast]:text-xs group-[.toast]:px-3.5 group-[.toast]:py-2",
          closeButton: "group-[.toast]:opacity-80 hover:opacity-100",
          success: isRTL ? "group-[.toaster]:!border-r-emerald-500 group-[.toaster]:!text-card-foreground" : "group-[.toaster]:!border-l-emerald-500 group-[.toaster]:!text-card-foreground",
          error: isRTL ? "group-[.toaster]:!border-r-destructive group-[.toaster]:!text-card-foreground" : "group-[.toaster]:!border-l-destructive group-[.toaster]:!text-card-foreground",
          warning: isRTL ? "group-[.toaster]:!border-r-amber-500 group-[.toaster]:!text-card-foreground" : "group-[.toaster]:!border-l-amber-500 group-[.toaster]:!text-card-foreground",
          info: isRTL ? "group-[.toaster]:!border-r-primary group-[.toaster]:!text-card-foreground" : "group-[.toaster]:!border-l-primary group-[.toaster]:!text-card-foreground",
        },
      }}
      {...props}
    />
  );
};

type ToastOpts = {
  id?: string | number;
  description?: unknown;
  duration?: number;
  persistent?: boolean;
  action?: { label?: string; onClick?: () => void };
};
type ToastArg = ToastOpts | string | undefined;
/** Only object options carry fields; a plain string (or nothing) carries none. */
const asOpts = (data: ToastArg): ToastOpts | undefined => (typeof data === 'object' && data !== null ? data : undefined);

function formatSonnerDesc(data?: ToastArg): string | undefined {
  if (!data) return undefined;
  if (typeof data === 'string') return data;
  if (data.description) return String(data.description);
  return undefined;
}

/**
 * Standardized POS Flow App Toast Wrapper
 * Bridges all Sonner calls to the unified in-app SmartToastCard.
 */
const toast = Object.assign(
  (message: unknown, data?: ToastArg) => {
    const opts = asOpts(data);
    const msg = typeof message === 'string' ? message : (message ? String(message) : '');
    const desc = formatSonnerDesc(data);
    showSmartToast({
      type: 'info',
      title: msg,
      description: desc,
      duration: opts?.duration || getSavedToastDuration(),
    });
    return String(Date.now());
  },
  sonnerToast,
  {
    error: (message: unknown, data?: ToastArg) => {
      const opts = asOpts(data);
      const msg = typeof message === 'string' ? message : (message ? String(message) : '');
      const desc = formatSonnerDesc(data);
      const isPersistent = opts?.duration === Infinity || opts?.persistent === true;
      showSmartToast({
        id: opts?.id ? String(opts?.id) : undefined,
        type: 'error',
        title: msg,
        description: desc,
        duration: isPersistent ? Infinity : (opts?.duration || 6000),
        primaryAction: opts?.action ? {
          label: opts?.action?.label,
          onClick: opts?.action?.onClick,
        } : undefined,
      });
      return String(Date.now());
    },
    warning: (message: unknown, data?: ToastArg) => {
      const opts = asOpts(data);
      const msg = typeof message === 'string' ? message : (message ? String(message) : '');
      const desc = formatSonnerDesc(data);
      showSmartToast({
        id: opts?.id ? String(opts?.id) : undefined,
        type: 'warning',
        title: msg,
        description: desc,
        duration: opts?.duration || 5000,
        primaryAction: opts?.action ? {
          label: opts?.action?.label,
          onClick: opts?.action?.onClick,
        } : undefined,
      });
      return String(Date.now());
    },
    info: (message: unknown, data?: ToastArg) => {
      const opts = asOpts(data);
      const msg = typeof message === 'string' ? message : (message ? String(message) : '');
      const desc = formatSonnerDesc(data);
      showSmartToast({
        id: opts?.id ? String(opts?.id) : undefined,
        type: 'info',
        title: msg,
        description: desc,
        duration: opts?.duration || getSavedToastDuration(),
        primaryAction: opts?.action ? {
          label: opts?.action?.label,
          onClick: opts?.action?.onClick,
        } : undefined,
      });
      return String(Date.now());
    },
    success: (message: unknown, data?: ToastArg) => {
      const opts = asOpts(data);
      const msg = typeof message === 'string' ? message : (message ? String(message) : '');
      const desc = formatSonnerDesc(data);
      showSmartToast({
        id: opts?.id ? String(opts?.id) : undefined,
        type: 'success',
        title: msg,
        description: desc,
        duration: opts?.duration || getSavedToastDuration(),
        primaryAction: opts?.action ? {
          label: opts?.action?.label,
          onClick: opts?.action?.onClick,
        } : undefined,
      });
      return String(Date.now());
    },
    dismiss: (toastId?: string | number) => {
      if (toastId) {
        hideSmartToastById(String(toastId));
      } else {
        hideSmartToast();
      }
      try {
        sonnerToast.dismiss(toastId);
      } catch { /* intentionally empty */ }
    },
  }
);

// Monkey-patch sonnerToast instance to unify components that import directly from 'sonner'
try {
  if (typeof sonnerToast === 'function') {
    const patch = sonnerToast as unknown as Record<string, unknown>;
    patch.success = toast.success;
    patch.error = toast.error;
    patch.warning = toast.warning;
    patch.info = toast.info;
    patch.dismiss = toast.dismiss;
  }
} catch { /* intentionally empty */ }

export { Toaster };
