// قراءة مدة بقاء الإشعار بدقة من الإعدادات المخزنة محلياً
export function getDefaultToastDuration(): number {
  try {
    const saved = localStorage.getItem('posflow_toast_duration');
    if (saved) {
      const val = Number(saved);
      if (!isNaN(val) && val >= 500 && val <= 10000) return val;
    }
  } catch { /* intentionally empty */ }
  return 2500;
}
