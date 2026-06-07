BEGIN;

DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_other_studio UUID := gen_random_uuid();
    v_student UUID := gen_random_uuid();
    v_other_student UUID := gen_random_uuid();
    v_same_studio_other_student UUID := gen_random_uuid();
    v_plan UUID := gen_random_uuid();
    v_other_plan UUID := gen_random_uuid();
    v_same_studio_other_plan UUID := gen_random_uuid();
    v_payer UUID := gen_random_uuid();
    v_invoice UUID := gen_random_uuid();
    v_enrollment UUID := gen_random_uuid();
    v_other_enrollment UUID := gen_random_uuid();
    v_same_studio_other_enrollment UUID := gen_random_uuid();
    v_error_message TEXT;
BEGIN
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
        v_owner,
        'authenticated',
        'authenticated',
        'billing-invoice-item-verification-' || replace(v_owner::TEXT, '-', '') || '@example.invalid',
        '{}'::jsonb,
        '{}'::jsonb,
        now(),
        now()
    );

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES
        (v_studio, 'Billing Invoice Item Verification Studio', 'billing-invoice-item-verification-' || replace(v_studio::TEXT, '-', ''), v_owner),
        (v_other_studio, 'Billing Invoice Item Other Studio', 'billing-invoice-item-other-' || replace(v_other_studio::TEXT, '-', ''), v_owner);

    INSERT INTO public.students (id, studio_id, legal_first_name, legal_last_name)
    VALUES
        (v_student, v_studio, 'Billing', 'Student'),
        (v_same_studio_other_student, v_studio, 'Other', 'Student'),
        (v_other_student, v_other_studio, 'Other', 'Studio');

    INSERT INTO public.billing_payers (id, studio_id, display_name)
    VALUES (v_payer, v_studio, 'Verification Payer');

    INSERT INTO public.billing_plans (id, studio_id, name, amount_cents)
    VALUES
        (v_plan, v_studio, 'Verification Plan', 1000),
        (v_same_studio_other_plan, v_studio, 'Other Verification Plan', 2000),
        (v_other_plan, v_other_studio, 'Other Studio Plan', 1000);

    INSERT INTO public.student_billing_enrollments (
        id,
        studio_id,
        student_id,
        payer_id,
        billing_plan_id
    )
    VALUES
        (v_enrollment, v_studio, v_student, v_payer, v_plan),
        (v_same_studio_other_enrollment, v_studio, v_same_studio_other_student, v_payer, v_same_studio_other_plan),
        (v_other_enrollment, v_other_studio, v_other_student, NULL, v_other_plan);

    INSERT INTO public.billing_invoices (
        id,
        studio_id,
        payer_id,
        student_id,
        enrollment_id,
        amount_due_cents
    )
    VALUES (v_invoice, v_studio, v_payer, v_student, v_enrollment, 1000);

    INSERT INTO public.billing_invoice_items (
        studio_id,
        invoice_id,
        student_id,
        enrollment_id,
        billing_plan_id,
        description,
        quantity,
        unit_amount_cents,
        amount_cents
    )
    VALUES (
        v_studio,
        v_invoice,
        v_student,
        v_enrollment,
        v_plan,
        'Valid verification item',
        1,
        1000,
        1000
    );

    BEGIN
        INSERT INTO public.billing_invoice_items (
            studio_id,
            invoice_id,
            enrollment_id,
            description
        )
        VALUES (
            v_studio,
            v_invoice,
            v_other_enrollment,
            'Invalid cross-studio enrollment'
        );
        RAISE EXCEPTION 'Expected cross-studio invoice item enrollment to be rejected.';
    EXCEPTION
        WHEN OTHERS THEN
            v_error_message := SQLERRM;
            IF v_error_message NOT LIKE '%enrollment must belong to the same studio%' THEN
                RAISE;
            END IF;
    END;

    BEGIN
        INSERT INTO public.billing_invoice_items (
            studio_id,
            invoice_id,
            billing_plan_id,
            description
        )
        VALUES (
            v_studio,
            v_invoice,
            v_other_plan,
            'Invalid cross-studio plan'
        );
        RAISE EXCEPTION 'Expected cross-studio invoice item billing plan to be rejected.';
    EXCEPTION
        WHEN OTHERS THEN
            v_error_message := SQLERRM;
            IF v_error_message NOT LIKE '%billing plan must belong to the same studio%' THEN
                RAISE;
            END IF;
    END;

    BEGIN
        INSERT INTO public.billing_invoice_items (
            studio_id,
            invoice_id,
            student_id,
            enrollment_id,
            description
        )
        VALUES (
            v_studio,
            v_invoice,
            v_student,
            v_same_studio_other_enrollment,
            'Invalid mismatched enrollment student'
        );
        RAISE EXCEPTION 'Expected mismatched invoice item enrollment student to be rejected.';
    EXCEPTION
        WHEN OTHERS THEN
            v_error_message := SQLERRM;
            IF v_error_message NOT LIKE '%enrollment must belong to the same student%' THEN
                RAISE;
            END IF;
    END;

    BEGIN
        INSERT INTO public.billing_invoice_items (
            studio_id,
            invoice_id,
            enrollment_id,
            billing_plan_id,
            description
        )
        VALUES (
            v_studio,
            v_invoice,
            v_enrollment,
            v_same_studio_other_plan,
            'Invalid mismatched enrollment plan'
        );
        RAISE EXCEPTION 'Expected mismatched invoice item enrollment plan to be rejected.';
    EXCEPTION
        WHEN OTHERS THEN
            v_error_message := SQLERRM;
            IF v_error_message NOT LIKE '%enrollment must belong to the same billing plan%' THEN
                RAISE;
            END IF;
    END;

    RAISE NOTICE 'Koaryu billing invoice item ref verification passed.';
END $$;

ROLLBACK;
