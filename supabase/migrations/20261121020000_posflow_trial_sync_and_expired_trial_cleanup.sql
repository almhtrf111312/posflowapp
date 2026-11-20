-- =============================================================================
-- 1) Trial accounts that registered a phone number may write to the cloud (sync).
--    Paid licenses behave exactly as before. Expired / revoked trials stay blocked.
-- 2) boss_expired_trials(): Boss-only list of owners whose trial ended and who never activated.
-- 3) purge_owner_data(): atomic, complete deletion of an owner's data (all tables with user_id,
--    plus the cashier sub-accounts' rows). delete_owner_cascade() now delegates to it.
--    The edge function delete-user removes the auth users only after this succeeds.
-- Rollback: supabase/live-snapshots/rollbacks/ROLLBACK_trial_sync_and_expired_trial_cleanup.sql
-- =============================================================================

-- 1) -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_paid_write_access(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    public.is_boss(_user_id)
    OR EXISTS (
      SELECT 1
      FROM public.app_licenses al
      WHERE al.user_id = public.get_owner_id(_user_id)
        AND COALESCE(al.is_revoked, false) = false
        AND al.expires_at > now()
        AND (
          COALESCE(al.is_trial, false) = false
          OR EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.user_id = al.user_id
              AND NULLIF(btrim(p.phone), '') IS NOT NULL
          )
        )
    );
$function$;

-- 2) -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.boss_expired_trials(_min_days integer DEFAULT 0)
RETURNS TABLE (
  user_id uuid,
  email text,
  full_name text,
  phone text,
  store_name text,
  trial_expired_at timestamptz,
  days_since_expired integer,
  products_count bigint,
  invoices_count bigint,
  customers_count bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_boss(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    t.user_id,
    u.email::text,
    p.full_name,
    p.phone,
    (SELECT s.name FROM public.stores s WHERE s.user_id = t.user_id ORDER BY s.created_at LIMIT 1),
    t.expires_at,
    GREATEST(0, floor(extract(epoch FROM (now() - t.expires_at)) / 86400))::integer,
    (SELECT count(*) FROM public.products x WHERE x.user_id = t.user_id),
    (SELECT count(*) FROM public.invoices x WHERE x.user_id = t.user_id),
    (SELECT count(*) FROM public.customers x WHERE x.user_id = t.user_id)
  FROM (
    SELECT DISTINCT ON (al.user_id) al.user_id, al.expires_at
    FROM public.app_licenses al
    WHERE COALESCE(al.is_trial, false) = true
      AND COALESCE(al.is_revoked, false) = false
      AND al.expires_at < now() - make_interval(days => GREATEST(_min_days, 0))
    ORDER BY al.user_id, al.expires_at DESC
  ) t
  JOIN auth.users u ON u.id = t.user_id
  LEFT JOIN public.profiles p ON p.user_id = t.user_id
  JOIN public.user_roles r ON r.user_id = t.user_id AND r.role = 'admin'
  WHERE NOT EXISTS (
    SELECT 1 FROM public.app_licenses a2
    WHERE a2.user_id = t.user_id
      AND COALESCE(a2.is_trial, false) = false
      AND COALESCE(a2.is_revoked, false) = false
      AND a2.expires_at > now()
  )
  ORDER BY t.expires_at ASC;
END;
$function$;

REVOKE ALL ON FUNCTION public.boss_expired_trials(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.boss_expired_trials(integer) TO authenticated, service_role;

-- 3) -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_owner_data(_owner_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _ids uuid[];
  _pending text[];
  _tbl text;
  _n bigint;
  _pass integer;
  _progress boolean;
  _result jsonb := '{}'::jsonb;
  _keep text[] := ARRAY['user_roles', 'profiles', 'app_licenses'];
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_boss(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF _owner_id IS NULL OR public.is_boss(_owner_id) THEN
    RAISE EXCEPTION 'cannot purge a boss or empty id';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.user_roles r
    WHERE r.user_id = _owner_id AND r.owner_id IS NOT NULL AND r.owner_id <> r.user_id
  ) THEN
    RAISE EXCEPTION 'target is a sub-account, not an owner';
  END IF;

  -- transaction-local switches that let the guard triggers (invoices / customers / partner ledger) allow this purge
  PERFORM set_config('app.invoice_delete_context', 'allowed', true);
  PERFORM set_config('app.purge_context', 'owner_purge', true);

  -- the owner + every cashier account that belongs to him
  _ids := ARRAY[_owner_id] || COALESCE(
    ARRAY(SELECT r.user_id FROM public.user_roles r WHERE r.owner_id = _owner_id AND r.user_id <> _owner_id),
    ARRAY[]::uuid[]
  );

  -- child rows that have no user_id and RESTRICT their parent
  DELETE FROM public.purchase_return_items i
  USING public.purchase_returns pr
  WHERE i.return_id = pr.id AND pr.user_id = ANY(_ids);
  GET DIAGNOSTICS _n = ROW_COUNT;
  _result := _result || jsonb_build_object('purchase_return_items', _n);

  -- support conversations are keyed by owner_id as well
  DELETE FROM public.support_conversations WHERE user_id = ANY(_ids) OR owner_id = ANY(_ids);
  GET DIAGNOSTICS _n = ROW_COUNT;
  _result := _result || jsonb_build_object('support_conversations', _n);

  -- every other table that carries a user_id column (roles / profile / license are removed last)
  SELECT array_agg(c.table_name ORDER BY c.table_name) INTO _pending
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
  WHERE c.table_schema = 'public'
    AND c.column_name = 'user_id'
    AND NOT (c.table_name = ANY(_keep));

  FOR _pass IN 1..8 LOOP
    _progress := false;
    FOREACH _tbl IN ARRAY COALESCE(_pending, ARRAY[]::text[]) LOOP
      BEGIN
        EXECUTE format('DELETE FROM public.%I WHERE user_id = ANY($1)', _tbl) USING _ids;
        GET DIAGNOSTICS _n = ROW_COUNT;
        IF _n > 0 THEN
          _result := _result || jsonb_build_object(_tbl, _n);
        END IF;
        _pending := array_remove(_pending, _tbl);
        _progress := true;
      EXCEPTION WHEN foreign_key_violation THEN
        NULL; -- a child table still references it: retry on the next pass
      END;
    END LOOP;
    EXIT WHEN COALESCE(cardinality(_pending), 0) = 0 OR NOT _progress;
  END LOOP;

  IF COALESCE(cardinality(_pending), 0) > 0 THEN
    RAISE EXCEPTION 'purge incomplete, blocked tables: %', array_to_string(_pending, ', ');
  END IF;

  DELETE FROM public.app_licenses WHERE user_id = ANY(_ids);
  DELETE FROM public.profiles WHERE user_id = ANY(_ids);
  DELETE FROM public.user_roles WHERE user_id = ANY(_ids) OR owner_id = _owner_id;

  PERFORM set_config('app.invoice_delete_context', '', true);
  PERFORM set_config('app.purge_context', '', true);

  RETURN _result;
END;
$function$;

REVOKE ALL ON FUNCTION public.purge_owner_data(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purge_owner_data(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.delete_owner_cascade(_owner_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Only boss can delete owners
  IF NOT public.is_boss(auth.uid()) THEN
    RETURN false;
  END IF;
  PERFORM public.purge_owner_data(_owner_id);
  RETURN true;
END;
$function$;

NOTIFY pgrst, 'reload schema';
