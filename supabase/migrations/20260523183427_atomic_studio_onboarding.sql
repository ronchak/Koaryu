-- ==========================================
-- Koaryu v1 — Atomic studio onboarding
-- ==========================================
--
-- Studio onboarding creates the tenant, owner admin role, audit entry, and
-- platform subscription together. Keep the browser on the FastAPI boundary:
-- this RPC is called only by the service-role backend.

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO service_role;

CREATE TABLE IF NOT EXISTS private.studio_creation_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    studio_id UUID REFERENCES public.studios(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, idempotency_key)
);

ALTER TABLE private.studio_creation_requests ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON private.studio_creation_requests TO service_role;

CREATE OR REPLACE FUNCTION public.create_studio_onboarding(
    p_user_id UUID,
    p_name TEXT,
    p_timezone TEXT DEFAULT 'America/New_York',
    p_idempotency_key TEXT DEFAULT NULL
)
RETURNS SETOF public.studios
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, private
AS $$
DECLARE
    v_name TEXT := btrim(COALESCE(p_name, ''));
    v_timezone TEXT := btrim(COALESCE(p_timezone, 'America/New_York'));
    v_key TEXT := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
    v_slug_base TEXT;
    v_slug TEXT;
    v_request_hash TEXT;
    v_existing_request private.studio_creation_requests%ROWTYPE;
    v_studio public.studios%ROWTYPE;
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'User id is required.'
            USING ERRCODE = '22023';
    END IF;

    IF v_name = '' THEN
        RAISE EXCEPTION 'Studio name is required.'
            USING ERRCODE = '22023';
    END IF;

    IF v_timezone = '' THEN
        RAISE EXCEPTION 'Timezone is required.'
            USING ERRCODE = '22023';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_timezone_names
        WHERE name = v_timezone
    ) THEN
        RAISE EXCEPTION 'Choose a valid timezone.'
            USING ERRCODE = '22023';
    END IF;

    IF v_key IS NOT NULL AND char_length(v_key) > 200 THEN
        RAISE EXCEPTION 'Idempotency key is too long.'
            USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtext('koaryu_studio_onboarding'),
        hashtext(p_user_id::TEXT)
    );

    v_request_hash := md5(v_name || chr(31) || v_timezone);

    IF v_key IS NOT NULL THEN
        SELECT *
        INTO v_existing_request
        FROM private.studio_creation_requests
        WHERE user_id = p_user_id
          AND idempotency_key = v_key
        FOR UPDATE;

        IF FOUND THEN
            IF v_existing_request.request_hash <> v_request_hash THEN
                RAISE EXCEPTION 'Idempotency key was already used for a different studio creation request.'
                    USING ERRCODE = '23505';
            END IF;

            IF v_existing_request.studio_id IS NULL THEN
                RAISE EXCEPTION 'Idempotent studio creation record is missing its studio.'
                    USING ERRCODE = 'P0002';
            END IF;

            RETURN QUERY
            SELECT *
            FROM public.studios
            WHERE id = v_existing_request.studio_id;

            IF NOT FOUND THEN
                RAISE EXCEPTION 'Idempotent studio creation record references a missing studio.'
                    USING ERRCODE = 'P0002';
            END IF;

            RETURN;
        END IF;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.staff_roles
        WHERE user_id = p_user_id
    ) OR EXISTS (
        SELECT 1
        FROM public.studios
        WHERE owner_id = p_user_id
    ) THEN
        RAISE EXCEPTION 'You already have a studio. Only one studio per account in v1.'
            USING ERRCODE = '23505';
    END IF;

    IF v_key IS NOT NULL THEN
        INSERT INTO private.studio_creation_requests (
            user_id,
            idempotency_key,
            request_hash
        )
        VALUES (
            p_user_id,
            v_key,
            v_request_hash
        );
    END IF;

    v_slug_base := btrim(
        regexp_replace(
            regexp_replace(
                regexp_replace(lower(v_name), '[^[:alnum:]_[:space:]-]', '', 'g'),
                '[[:space:]_]+',
                '-',
                'g'
            ),
            '-+',
            '-',
            'g'
        ),
        '-'
    );

    IF v_slug_base = '' THEN
        v_slug_base := 'studio';
    END IF;

    v_slug := v_slug_base || '-' || substr(replace(gen_random_uuid()::TEXT, '-', ''), 1, 6);

    INSERT INTO public.studios (
        name,
        slug,
        owner_id,
        timezone
    )
    VALUES (
        v_name,
        v_slug,
        p_user_id,
        v_timezone
    )
    RETURNING * INTO v_studio;

    INSERT INTO public.staff_roles (
        studio_id,
        user_id,
        role
    )
    VALUES (
        v_studio.id,
        p_user_id,
        'admin'
    );

    INSERT INTO public.audit_logs (
        studio_id,
        actor_id,
        action,
        entity_type,
        entity_id,
        metadata
    )
    VALUES (
        v_studio.id,
        p_user_id,
        'studio.created',
        'studio',
        v_studio.id,
        jsonb_build_object('name', v_name)
    );

    INSERT INTO public.studio_subscriptions (
        studio_id,
        status,
        comped,
        current_period_start
    )
    VALUES (
        v_studio.id,
        'incomplete',
        false,
        now()
    );

    IF v_key IS NOT NULL THEN
        UPDATE private.studio_creation_requests
        SET studio_id = v_studio.id,
            updated_at = now()
        WHERE user_id = p_user_id
          AND idempotency_key = v_key;
    END IF;

    RETURN NEXT v_studio;
    RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.create_studio_onboarding(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_studio_onboarding(UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.create_studio_onboarding(UUID, TEXT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_studio_onboarding(UUID, TEXT, TEXT, TEXT) TO service_role;

-- The browser-facing onboarding insert path is replaced by the backend RPC
-- above. Leaving these policies open would let a client recreate the old
-- non-atomic studio + staff_role sequence without audit/subscription rows.
DROP POLICY IF EXISTS "studios_insert_auth" ON public.studios;
DROP POLICY IF EXISTS "studios_insert_owner" ON public.studios;
DROP POLICY IF EXISTS "staff_roles_insert_auth" ON public.staff_roles;
DROP POLICY IF EXISTS "staff_roles_insert_owner" ON public.staff_roles;

REVOKE INSERT ON public.studios FROM anon, authenticated;
REVOKE INSERT ON public.staff_roles FROM anon, authenticated;
