-- mark_all_support_messages_read()
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.mark_all_support_messages_read()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_updated integer := 0;
BEGIN
  -- التحقق من أن المستدعي هو المدير العام حصراً
  IF NOT public.is_boss(v_caller) THEN
    RETURN jsonb_build_object('success', false, 'error', 'غير مصرح: هذا الإجراء مخصص للمدير العام فقط');
  END IF;

  -- تحديث كافة رسائل العملاء غير المقروءة إلى مقروءة
  UPDATE public.support_messages
  SET is_read = true
  WHERE is_read = false AND sender_role = 'user';

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN jsonb_build_object('success', true, 'updated_count', v_updated);
END;
$function$
;
