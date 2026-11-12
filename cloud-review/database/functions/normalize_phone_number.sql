-- normalize_phone_number(p_phone text)
-- SECURITY DEFINER: False
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.normalize_phone_number(p_phone text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
    v_clean TEXT;
BEGIN
    IF p_phone IS NULL OR trim(p_phone) = '' THEN
        RETURN NULL;
    END IF;

    -- إزالة كافة الرموز والمسافات والأقواس والإبقاء على الأرقام فقط وعلامة الزائد
    v_clean := regexp_replace(trim(p_phone), '[^\+0-9]', '', 'g');

    -- تحويل 00 في بداية الرقم الدولي إلى +
    IF v_clean ~ '^00' THEN
        v_clean := '+' || substring(v_clean from 3);
    END IF;

    -- إذا كان الرقم السوري يبدأ بـ 09 ننسقه إلى +9639
    IF v_clean ~ '^09[0-9]{8}$' THEN
        v_clean := '+963' || substring(v_clean from 2);
    -- إذا كان الرقم التركي يبدأ بـ 05 ننسقه إلى +905
    ELSIF v_clean ~ '^05[0-9]{9}$' THEN
        v_clean := '+90' || substring(v_clean from 2);
    END IF;

    -- إذا لم يحمل علامة + وكان رقماً محلياً، نتركه نظيفاً من المسافات
    IF v_clean = '' THEN
        RETURN NULL;
    END IF;

    RETURN v_clean;
END;
$function$
;
