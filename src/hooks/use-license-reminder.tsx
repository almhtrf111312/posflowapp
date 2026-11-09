import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { showToast } from '@/lib/toast';
import { useLicense } from './use-license';
import { useAuth } from './use-auth';

const MILESTONES = [30, 10, 3, 1, 0];

export function useLicenseReminder() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const license = useLicense();
  const licenseState = (license as any)?.licenseState || license;

  useEffect(() => {
    if (!user?.id || licenseState.remainingDays === undefined || licenseState.remainingDays === null) return;

    const remaining = licenseState.remainingDays;
    const storageKey = `hyperpos_license_milestone_${user.id}`;
    let seenMilestones: number[] = [];
    try {
      seenMilestones = JSON.parse(localStorage.getItem(storageKey) || '[]');
    } catch {
      seenMilestones = [];
    }

    // العثور على أقرب محطة مستحقة لم يتم تنبيه المستخدم بها بعد
    const targetMilestone = MILESTONES.find(m => remaining <= m && !seenMilestones.includes(m));

    if (targetMilestone !== undefined) {
      seenMilestones.push(targetMilestone);
      try {
        localStorage.setItem(storageKey, JSON.stringify(seenMilestones));
      } catch { /* ignore */ }

      // إطلاق الإشعار التفاعلي
      const title = remaining <= 0 ? '⚠️ انتهى اشتراكك' : `⚠️ تنبيه: يتبقى ${remaining} يوماً على انتهاء اشتراكك`;
      showToast.warning(title, {
        description: 'انقر هنا لتجديد الاشتراك واختيار باقتك المفضلة',
        action: {
          label: 'تجديد الآن',
          onClick: () => navigate('/renew'),
        }
      });
    }
  }, [user?.id, licenseState.remainingDays, navigate]);
}
