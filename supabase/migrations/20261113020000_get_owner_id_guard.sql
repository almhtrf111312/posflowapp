-- =========================================================================
-- get_owner_id: لا يكشف مالك متجر مستخدم آخر
-- الدالة تُستخدم في 81 سياسة أمان (دائماً مع auth.uid())، فلا نغيّر اسمها ولا توقيعها:
--   1) منطقها الحالي ينتقل حرفياً إلى get_owner_id__resolve (مغلقة أمام التطبيق)
--   2) get_owner_id نفسها (نفس المعرّف، فالسياسات لا تتأثر) تعيد النتيجة فقط إذا:
--      سأل المستخدم عن نفسه، أو عن عضو في متجره، أو كان البوس، أو كان النداء من الخادم.
-- آمن لإعادة التشغيل. الرجوع: أعد تشغيل cloud-review/database/functions/get_owner_id.sql
-- =========================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.get_owner_id__resolve(_user_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _role app_role;
  _owner_id uuid;
  _is_active boolean;
  _owner_active boolean;
BEGIN
  IF _user_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- استخراج الدور وحالة النشاط ومعرف المالك
  SELECT role, owner_id, COALESCE(is_active, true)
    INTO _role, _owner_id, _is_active
  FROM public.user_roles
  WHERE user_id = _user_id
  LIMIT 1;

  -- إذا كان الحساب غير نشط (معطل) يتم قطع الوصول فوراً
  IF _is_active IS FALSE THEN
    RETURN NULL;
  END IF;

  -- إذا كان كاشيراً، يجب التحقق أيضاً من أن متجر المالك ليس معطلاً
  IF _role = 'cashier' AND _owner_id IS NOT NULL THEN
    SELECT COALESCE(is_active, true) INTO _owner_active
    FROM public.user_roles
    WHERE user_id = _owner_id
    LIMIT 1;

    IF _owner_active IS FALSE THEN
      RETURN NULL;
    END IF;

    RETURN _owner_id;
  END IF;

  -- إذا كان مديراً أو Boss ونشطاً، فهو صاحب المتجر
  IF _role IN ('admin', 'boss') OR _owner_id IS NULL THEN
    RETURN _user_id;
  END IF;

  RETURN _owner_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_owner_id__resolve(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_owner_id__resolve(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.get_owner_id(_user_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _res uuid;
BEGIN
  _res := public.get_owner_id__resolve(_user_id);
  -- الخادم، أو السؤال عن النفس (كل سياسات الأمان): كما كان تماماً
  IF _caller IS NULL OR _user_id = _caller THEN
    RETURN _res;
  END IF;
  -- البوس، أو عضو من نفس المتجر
  IF public.is_boss(_caller) OR _res IS NOT DISTINCT FROM public.get_owner_id__resolve(_caller) THEN
    RETURN _res;
  END IF;
  RETURN NULL;
END;
$function$;

COMMIT;

-- التحقق: يجب أن تكون true
SELECT
  EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'get_owner_id__resolve' AND pronamespace = 'public'::regnamespace)
  AND position('get_owner_id__resolve' in pg_get_functiondef('public.get_owner_id(uuid)'::regprocedure)) > 0
  AND NOT has_function_privilege('authenticated', 'public.get_owner_id__resolve(uuid)'::regprocedure, 'execute')
  AS owner_lookup_guarded;
