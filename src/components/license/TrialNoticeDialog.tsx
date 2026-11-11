import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface TrialNoticeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

const TRIAL_NOTICE_POINTS = [
  'بياناتك تُحفظ محلياً على هذا الجهاز فقط، ولا تُرفع إلى السحابة.',
  'في حال عدم الاشتراك لن يتم الاحتفاظ بنسخة احتياطية لبياناتك في السحابة.',
  'تُمسح بيانات التجربة عند الخروج من التطبيق.',
  'المنتجات الموجودة في التجربة نماذج للعرض والتجربة فقط.',
  'بعد تفعيل الاشتراك تُرفع بياناتك إلى السحابة تلقائياً.',
];

export function TrialNoticeDialog({ open, onOpenChange, onConfirm }: TrialNoticeDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent dir="rtl" className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>قبل بدء الفترة التجريبية</AlertDialogTitle>
          <AlertDialogDescription>
            يرجى الاطلاع على الشروط التالية قبل المتابعة:
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="list-disc space-y-2 ps-5 text-sm text-muted-foreground">
          {TRIAL_NOTICE_POINTS.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel>إلغاء</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>أفهم، ابدأ التجربة</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
