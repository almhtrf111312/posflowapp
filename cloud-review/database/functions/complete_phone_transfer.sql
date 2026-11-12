-- complete_phone_transfer(_request_id uuid, _entered_code text)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.complete_phone_transfer(_request_id uuid, _entered_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'extensions'
AS $function$
DECLARE
    _caller UUID := auth.uid();
    _req RECORD;
BEGIN
    IF _caller IS NULL THEN
        RAISE EXCEPTION 'غير مصرح: يجب تسجيل الدخول';
    END IF;

    SELECT * INTO _req
    FROM public.phone_transfer_requests
    WHERE id = _request_id AND target_user_id = _caller;

    IF _req.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'طلب التحقق غير موجود أو منتهي الصلاحية');
    END IF;

    IF _req.expires_at < now() THEN
        DELETE FROM public.phone_transfer_requests WHERE id = _request_id;
        RETURN jsonb_build_object('ok', false, 'error', 'انتهت صلاحية رمز التحقق، يرجى طلب رمز جديد');
    END IF;

    IF _req.attempts >= 3 THEN
        DELETE FROM public.phone_transfer_requests WHERE id = _request_id;
        RETURN jsonb_build_object('ok', false, 'error', 'تم تجاوز الحد الأقصى للمحاولات الخاطئة. اطلب رمزاً جديداً');
    END IF;

    -- فحص تطابق الرمز (Sha256)
    IF _req.code_hash <> encode(digest(trim(_entered_code), 'sha256'), 'hex') THEN
        UPDATE public.phone_transfer_requests
        SET attempts = attempts + 1
        WHERE id = _request_id;
        
        RETURN jsonb_build_object(
            'ok', false, 
            'error', 'رمز التحقق غير صحيح، المحاولات المتبقية: ' || (2 - _req.attempts)
        );
    END IF;

    -- نقل ذري للملكية (Atomic Transfer)
    -- خطوة أ: تفريغ الرقم من الحساب القديم لفك قيد التفرد
    UPDATE public.profiles
    SET phone = NULL, updated_at = now()
    WHERE user_id = _req.source_user_id;

    -- خطوة ب: ربط الرقم بالحساب الجديد
    UPDATE public.profiles
    SET phone = _req.phone, updated_at = now()
    WHERE user_id = _caller;

    -- خطوة ج: تحديث المتجر للحساب الجديد
    UPDATE public.stores
    SET phone = _req.phone
    WHERE user_id = _caller;

    -- حذف الطلب بعد اكتماله بنجاح
    DELETE FROM public.phone_transfer_requests WHERE id = _request_id;

    RETURN jsonb_build_object(
        'ok', true,
        'status', 'transferred',
        'normalized_phone', _req.phone,
        'message', 'تم نقل الرقم وربطه بحسابك وبمتجرك بنجاح'
    );
END;
$function$
;
