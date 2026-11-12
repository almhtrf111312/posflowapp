-- issue_offline_lease(p_device_id text)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.issue_offline_lease(p_device_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'extensions'
AS $function$
DECLARE
    v_user_id uuid := auth.uid();
    v_owner_id uuid;
    v_license record;
    v_expires_at timestamptz;
    v_valid_until_epoch bigint;
    v_payload text;
    v_secret text;
    v_signature text;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: User not authenticated';
    END IF;

    -- جلب حساب المالك (متوافق مع الكاشير وصاحب الحساب)
    v_owner_id := public.get_owner_id(v_user_id);

    -- جلب الترخيص الفعّال
    SELECT * INTO v_license
    FROM public.app_licenses
    WHERE user_id = v_owner_id AND (is_revoked IS FALSE OR is_revoked IS NULL)
    LIMIT 1;

    IF v_license IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'NO_ACTIVE_LICENSE'
        );
    END IF;

    -- التحقق من ربط الجهاز
    IF v_license.device_id IS NOT NULL 
       AND v_license.allow_multi_device IS NOT TRUE 
       AND v_license.device_id <> p_device_id THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'DEVICE_MISMATCH'
        );
    END IF;

    -- حساب تاريخ انتهاء الأوفلاين (الأقرب بين نهاية الترخيص وسقف أيام الأوفلاين المسموح)
    v_expires_at := LEAST(
        v_license.expires_at, 
        now() + (COALESCE(v_license.max_offline_days, 15) || ' days')::interval
    );
    v_valid_until_epoch := EXTRACT(EPOCH FROM v_expires_at)::bigint;

    -- إعداد السر والـ Payload
    v_secret := COALESCE(v_license.offline_lease_secret, 'FLOWPOS_PRO_FALLBACK_SALT_2026');
    v_payload := v_license.id || ':' || p_device_id || ':' || v_valid_until_epoch || ':' || COALESCE(v_license.max_offline_invoices, 100);
    
    -- توليد التوقيع الرقمي الموثوق عبر SHA256 الأصيل
    v_signature := encode(sha256((v_payload || ':' || v_secret)::bytea), 'hex');

    -- تحديث توقيت إصدار التذكرة
    UPDATE public.app_licenses 
    SET last_lease_issued_at = now() 
    WHERE id = v_license.id;

    RETURN jsonb_build_object(
        'success', true,
        'license_id', v_license.id,
        'device_id', p_device_id,
        'valid_until_epoch', v_valid_until_epoch,
        'max_offline_invoices', COALESCE(v_license.max_offline_invoices, 100),
        'signature', v_signature,
        'issued_at_epoch', EXTRACT(EPOCH FROM now())::bigint
    );
END;
$function$
;
