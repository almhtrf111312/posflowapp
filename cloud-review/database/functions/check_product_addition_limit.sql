-- check_product_addition_limit(p_owner_id uuid, p_has_image boolean)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}

CREATE OR REPLACE FUNCTION public.check_product_addition_limit(p_owner_id uuid, p_has_image boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_license record;
  v_count integer;
  v_max_allowed integer := 100;
  v_tier text := 'trial';
BEGIN
  SELECT * INTO v_license FROM public.app_licenses WHERE user_id = p_owner_id;
  
  IF v_license.id IS NOT NULL THEN
    v_tier := COALESCE(v_license.license_tier, CASE WHEN v_license.is_trial THEN 'trial' ELSE 'standard' END);
    v_max_allowed := COALESCE(v_license.max_products, 
      CASE 
        WHEN v_tier = 'institution' THEN 5000
        WHEN v_tier = 'pro' THEN 1000
        WHEN v_tier = 'standard' THEN 600
        ELSE 100
      END
    );
  END IF;

  SELECT count(*) INTO v_count FROM public.products WHERE user_id = p_owner_id;

  IF v_count >= v_max_allowed THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'product_limit_reached',
      'current_count', v_count,
      'max_allowed', v_max_allowed,
      'tier', v_tier,
      'message', 'لقد بلغت الحد الأقصى للمنتجات المسموحة في باقتك الحالية (' || v_max_allowed || ' منتج). يُرجى ترقية الاشتراك لإضافة المزيد.'
    );
  END IF;

  IF v_tier = 'pro' AND v_count >= 600 AND p_has_image THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'image_not_allowed_above_limit',
      'current_count', v_count,
      'max_allowed', v_max_allowed,
      'tier', v_tier,
      'message', 'في الباقة الاحترافية (Pro)، يُسمح بإضافة المنتجات بعد 600 منتج بدون صور فقط (حتى 1000 منتج).'
    );
  END IF;

  RETURN jsonb_build_object(
    'allowed', true,
    'current_count', v_count,
    'max_allowed', v_max_allowed,
    'tier', v_tier
  );
END;
$function$
;
