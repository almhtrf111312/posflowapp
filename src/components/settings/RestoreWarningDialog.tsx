import { useEffect, useState } from 'react';
import {
  AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Loader2, ShieldAlert } from 'lucide-react';
import { useLanguage } from '@/hooks/language-context';

interface Props {
  open: boolean;
  fileName: string;
  summary: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const SECONDS = 10;

/** تحذير الاستعادة: يظهر مرة واحدة وزر الموافقة يتفعّل بعد عدّاد 10 ثوانٍ */
export function RestoreWarningDialog({ open, fileName, summary, busy, onConfirm, onCancel }: Props) {
  const { direction } = useLanguage();
  const [left, setLeft] = useState(SECONDS);

  useEffect(() => {
    if (!open) { setLeft(SECONDS); return; }
    setLeft(SECONDS);
    const id = window.setInterval(() => setLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => window.clearInterval(id);
  }, [open]);

  return (
    <AlertDialog open={open}>
      <AlertDialogContent dir={direction}>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-destructive">
            <ShieldAlert className="w-5 h-5" /> تحذير قبل الاستعادة
          </AlertDialogTitle>
          <AlertDialogDescription className="space-y-2 text-start leading-relaxed">
            <span className="block">الملف: <b>{fileName}</b></span>
            {summary && <span className="block text-xs">{summary}</span>}
            <span className="block">
              عند الاستعادة من هذا الملف ستفقد <b>آخر نسخة احتياطية موجودة على السحابة</b>، لأن هذا الملف
              سيُزامَن إلى السحابة ويحلّ محلها. البيانات الحالية في حسابك تُدمج بالبيانات المستعادة
              (العناصر بنفس المعرّف تُحدَّث).
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>إلغاء</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={left > 0 || busy}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : left > 0 ? `أوافق (${left})` : 'أوافق وأستعيد'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default RestoreWarningDialog;
