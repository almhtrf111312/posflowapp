/**
 * موضع الأزرار العائمة بجانب القائمة الجانبية: على الآيباد والكمبيوتر القائمة مثبتة على الحافة،
 * فيُزاح الزر بعرضها (المتغير --sidebar-offset يضبطه Sidebar، وهو صفر على الجوال).
 */
export function floatingSideClass(isRTL: boolean) {
  return isRTL
    ? 'right-[calc(1.25rem+var(--sidebar-offset,0px))] sm:right-[calc(2rem+var(--sidebar-offset,0px))]'
    : 'left-[calc(1.25rem+var(--sidebar-offset,0px))] sm:left-[calc(2rem+var(--sidebar-offset,0px))]';
}
export const floatingBottomClass = 'bottom-[calc(1.5rem+env(safe-area-inset-bottom))] sm:bottom-8';
