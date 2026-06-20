BEGIN;

SELECT set_config('koaryu.verification_owner', gen_random_uuid()::TEXT, true);
SELECT set_config('koaryu.verification_key', gen_random_uuid()::TEXT, true);
SELECT set_config('koaryu.verification_partial_owner', gen_random_uuid()::TEXT, true);
SELECT set_config('koaryu.verification_partial_studio', gen_random_uuid()::TEXT, true);

INSERT INTO auth.users (
    id,
    aud,
    role,
    email,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at
)
VALUES (
    current_setting('koaryu.verification_owner')::UUID,
    'authenticated',
    'authenticated',
    'koaryu-onboarding-verification-' ||
        replace(current_setting('koaryu.verification_owner'), '-', '') ||
        '@example.invalid',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
);

INSERT INTO auth.users (
    id,
    aud,
    role,
    email,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at
)
VALUES (
    current_setting('koaryu.verification_partial_owner')::UUID,
    'authenticated',
    'authenticated',
    'koaryu-onboarding-partial-' ||
        replace(current_setting('koaryu.verification_partial_owner'), '-', '') ||
        '@example.invalid',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
);

INSERT INTO public.studios (
    id,
    name,
    slug,
    owner_id,
    timezone
)
VALUES (
    current_setting('koaryu.verification_partial_studio')::UUID,
    'Partial Verification Studio',
    'partial-verification-' ||
        replace(current_setting('koaryu.verification_partial_studio'), '-', ''),
    current_setting('koaryu.verification_partial_owner')::UUID,
    'UTC'
);

SET LOCAL ROLE service_role;

DO $$
DECLARE
    v_owner UUID := current_setting('koaryu.verification_owner')::UUID;
    v_key TEXT := current_setting('koaryu.verification_key');
    v_partial_owner UUID := current_setting('koaryu.verification_partial_owner')::UUID;
    v_studio public.studios%ROWTYPE;
    v_replayed public.studios%ROWTYPE;
    v_count INTEGER;
    v_expected_exception BOOLEAN := false;
BEGIN
    SELECT *
    INTO v_studio
    FROM public.create_studio_onboarding(
        v_owner,
        '  Koaryu Verification Studio  ',
        'UTC',
        v_key
    )
    LIMIT 1;

    IF v_studio.id IS NULL THEN
        RAISE EXCEPTION 'Atomic onboarding did not return a studio.';
    END IF;

    IF v_studio.name <> 'Koaryu Verification Studio' THEN
        RAISE EXCEPTION 'Expected trimmed studio name, got %.', v_studio.name;
    END IF;

    IF v_studio.timezone <> 'UTC' THEN
        RAISE EXCEPTION 'Expected UTC timezone, got %.', v_studio.timezone;
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.staff_roles
    WHERE studio_id = v_studio.id
      AND user_id = v_owner
      AND role = 'admin';

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Expected one owner admin staff role, got %.', v_count;
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.audit_logs
    WHERE studio_id = v_studio.id
      AND actor_id = v_owner
      AND action = 'studio.created'
      AND entity_type = 'studio'
      AND entity_id = v_studio.id;

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Expected one studio.created audit log, got %.', v_count;
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.studio_subscriptions
    WHERE studio_id = v_studio.id
      AND status = 'incomplete'
      AND comped = false;

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Expected one incomplete non-comped studio subscription, got %.', v_count;
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM private.studio_creation_requests
    WHERE user_id = v_owner
      AND idempotency_key = v_key
      AND studio_id = v_studio.id;

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Expected one stored idempotency request, got %.', v_count;
    END IF;

    SELECT *
    INTO v_replayed
    FROM public.create_studio_onboarding(
        v_owner,
        'Koaryu Verification Studio',
        'UTC',
        v_key
    )
    LIMIT 1;

    IF v_replayed.id <> v_studio.id THEN
        RAISE EXCEPTION 'Idempotent replay returned %, expected %.', v_replayed.id, v_studio.id;
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.studios
    WHERE owner_id = v_owner;

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Expected one studio after idempotent replay, got %.', v_count;
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.staff_roles
    WHERE studio_id = v_studio.id
      AND user_id = v_owner
      AND role = 'admin';

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Expected one staff role after idempotent replay, got %.', v_count;
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.audit_logs
    WHERE studio_id = v_studio.id
      AND action = 'studio.created';

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Expected one audit log after idempotent replay, got %.', v_count;
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.studio_subscriptions
    WHERE studio_id = v_studio.id;

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Expected one subscription after idempotent replay, got %.', v_count;
    END IF;

    BEGIN
        PERFORM *
        FROM public.create_studio_onboarding(
            v_owner,
            'Different Payload',
            'UTC',
            v_key
        );
    EXCEPTION
        WHEN unique_violation THEN
            v_expected_exception := true;
    END;

    IF NOT v_expected_exception THEN
        RAISE EXCEPTION 'Expected same idempotency key with different payload to fail.';
    END IF;

    v_expected_exception := false;

    BEGIN
        PERFORM *
        FROM public.create_studio_onboarding(
            v_owner,
            'Second Studio',
            'UTC',
            gen_random_uuid()::TEXT
        );
    EXCEPTION
        WHEN unique_violation THEN
            v_expected_exception := true;
    END;

    IF NOT v_expected_exception THEN
        RAISE EXCEPTION 'Expected second studio creation for the same account to fail.';
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.studios
    WHERE owner_id = v_owner;

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Expected failed second creation to leave one studio, got %.', v_count;
    END IF;

    v_expected_exception := false;

    BEGIN
        PERFORM *
        FROM public.create_studio_onboarding(
            v_partial_owner,
            'Owner Only Residue',
            'UTC',
            gen_random_uuid()::TEXT
        );
    EXCEPTION
        WHEN unique_violation THEN
            v_expected_exception := true;
    END;

    IF NOT v_expected_exception THEN
        RAISE EXCEPTION 'Expected owner-only partial account residue to block onboarding.';
    END IF;
END $$;

RESET ROLE;

SET LOCAL ROLE authenticated;

DO $$
DECLARE
    v_owner UUID := current_setting('koaryu.verification_owner')::UUID;
    v_expected_exception BOOLEAN := false;
BEGIN
    BEGIN
        PERFORM *
        FROM public.create_studio_onboarding(
            v_owner,
            'Unauthorized Authenticated Studio',
            'UTC',
            gen_random_uuid()::TEXT
        );
    EXCEPTION
        WHEN insufficient_privilege THEN
            v_expected_exception := true;
    END;

    IF NOT v_expected_exception THEN
        RAISE EXCEPTION 'Expected authenticated role to be unable to execute create_studio_onboarding.';
    END IF;

    v_expected_exception := false;

    BEGIN
        INSERT INTO public.studios (
            name,
            slug,
            owner_id,
            timezone
        )
        VALUES (
            'Unauthorized Direct Studio',
            'unauthorized-direct-' || replace(gen_random_uuid()::TEXT, '-', ''),
            v_owner,
            'UTC'
        );
    EXCEPTION
        WHEN insufficient_privilege THEN
            v_expected_exception := true;
    END;

    IF NOT v_expected_exception THEN
        RAISE EXCEPTION 'Expected authenticated role to be unable to insert studios directly.';
    END IF;

    v_expected_exception := false;

    BEGIN
        INSERT INTO public.staff_roles (
            studio_id,
            user_id,
            role
        )
        VALUES (
            current_setting('koaryu.verification_partial_studio')::UUID,
            v_owner,
            'admin'
        );
    EXCEPTION
        WHEN insufficient_privilege THEN
            v_expected_exception := true;
    END;

    IF NOT v_expected_exception THEN
        RAISE EXCEPTION 'Expected authenticated role to be unable to insert staff_roles directly.';
    END IF;
END $$;

RESET ROLE;

SET LOCAL ROLE anon;

DO $$
DECLARE
    v_expected_exception BOOLEAN := false;
BEGIN
    BEGIN
        PERFORM *
        FROM public.create_studio_onboarding(
            current_setting('koaryu.verification_owner')::UUID,
            'Unauthorized Anonymous Studio',
            'UTC',
            gen_random_uuid()::TEXT
        );
    EXCEPTION
        WHEN insufficient_privilege THEN
            v_expected_exception := true;
    END;

    IF NOT v_expected_exception THEN
        RAISE EXCEPTION 'Expected anon role to be unable to execute create_studio_onboarding.';
    END IF;
END $$;

RESET ROLE;

DO $$
DECLARE
    v_owner UUID := current_setting('koaryu.verification_owner')::UUID;
    v_count INTEGER;
BEGIN
    SELECT COUNT(*)
    INTO v_count
    FROM public.studios
    WHERE owner_id = v_owner;

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Expected exactly one verified studio after role checks, got %.', v_count;
    END IF;
END $$;

ROLLBACK;
