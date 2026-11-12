-- send_support_message(_message text, _conversation_id uuid)
-- SECURITY DEFINER: True
-- EXECUTE grants (proacl): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.send_support_message(_message text, _conversation_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _owner uuid;
  _conv_id uuid := _conversation_id;
  _is_boss_user boolean;
  _user_email text;
  _user_phone text;
  _user_name text;
  _store_name text;
  _msg_id uuid;
  _role text;
BEGIN
  IF _uid IS NULL THEN 
    RAISE EXCEPTION 'غير مصرح'; 
  END IF;

  IF trim(COALESCE(_message, '')) = '' THEN 
    RAISE EXCEPTION 'لا يمكن إرسال رسالة فارغة'; 
  END IF;

  _is_boss_user := public.is_boss(_uid);
  _owner := public.get_owner_id(_uid);

  -- إذا كان المرسل هو البوس ويرد على محادثة محددة
  IF _is_boss_user AND _conv_id IS NOT NULL THEN
    _role := 'boss';
  ELSE
    _role := 'user';
    
    -- إذا لم يحدد المستخدم محادثة، نبحث عن محادثته المفتوحة أو ننشئ واحدة جديدة
    IF _conv_id IS NULL THEN
      SELECT id INTO _conv_id 
      FROM public.support_conversations 
      WHERE user_id = _uid
      ORDER BY created_at DESC 
      LIMIT 1;

      IF _conv_id IS NULL THEN
        -- سحب بيانات العميل تلقائياً
        SELECT email INTO _user_email FROM auth.users WHERE id = _uid;
        SELECT full_name, phone INTO _user_name, _user_phone FROM public.profiles WHERE user_id = _uid;
        SELECT name INTO _store_name FROM public.stores WHERE user_id = COALESCE(_owner, _uid) LIMIT 1;

        INSERT INTO public.support_conversations (
          user_id, owner_id, user_name, user_email, user_phone, store_name
        ) VALUES (
          _uid, _owner, _user_name, _user_email, _user_phone, _store_name
        ) RETURNING id INTO _conv_id;
      END IF;
    END IF;
  END IF;

  -- إدراج الرسالة
  INSERT INTO public.support_messages (conversation_id, sender_id, sender_role, message)
  VALUES (_conv_id, _uid, _role, trim(_message))
  RETURNING id INTO _msg_id;

  -- تحديث وقت آخر رسالة في المحادثة
  UPDATE public.support_conversations 
  SET last_message_at = now(), updated_at = now(), status = 'open'
  WHERE id = _conv_id;

  RETURN jsonb_build_object(
    'success', true,
    'message_id', _msg_id,
    'conversation_id', _conv_id,
    'role', _role,
    'created_at', now()
  );
END;
$function$
;
