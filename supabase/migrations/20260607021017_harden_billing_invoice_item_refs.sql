-- Harden billing invoice item tenant checks for service-role writes and
-- future maintenance scripts. Earlier versions validated invoice/student
-- ownership only; enrollment and billing plan links must be tenant-locked too.

CREATE OR REPLACE FUNCTION public.validate_billing_invoice_item_refs()
RETURNS TRIGGER AS $$
DECLARE
    invoice_studio UUID;
    student_studio UUID;
    enrollment_studio UUID;
    enrollment_student UUID;
    enrollment_plan UUID;
    plan_studio UUID;
BEGIN
    SELECT studio_id INTO invoice_studio
    FROM public.billing_invoices
    WHERE id = NEW.invoice_id;

    IF invoice_studio IS NULL OR invoice_studio <> NEW.studio_id THEN
        RAISE EXCEPTION 'Billing invoice item invoice must belong to the same studio';
    END IF;

    IF NEW.student_id IS NOT NULL THEN
        SELECT studio_id INTO student_studio
        FROM public.students
        WHERE id = NEW.student_id;

        IF student_studio IS NULL OR student_studio <> NEW.studio_id THEN
            RAISE EXCEPTION 'Billing invoice item student must belong to the same studio';
        END IF;
    END IF;

    IF NEW.enrollment_id IS NOT NULL THEN
        SELECT studio_id, student_id, billing_plan_id
        INTO enrollment_studio, enrollment_student, enrollment_plan
        FROM public.student_billing_enrollments
        WHERE id = NEW.enrollment_id;

        IF enrollment_studio IS NULL OR enrollment_studio <> NEW.studio_id THEN
            RAISE EXCEPTION 'Billing invoice item enrollment must belong to the same studio';
        END IF;

        IF NEW.student_id IS NOT NULL AND enrollment_student IS DISTINCT FROM NEW.student_id THEN
            RAISE EXCEPTION 'Billing invoice item enrollment must belong to the same student';
        END IF;

        IF NEW.billing_plan_id IS NOT NULL AND enrollment_plan IS DISTINCT FROM NEW.billing_plan_id THEN
            RAISE EXCEPTION 'Billing invoice item enrollment must belong to the same billing plan';
        END IF;
    END IF;

    IF NEW.billing_plan_id IS NOT NULL THEN
        SELECT studio_id INTO plan_studio
        FROM public.billing_plans
        WHERE id = NEW.billing_plan_id;

        IF plan_studio IS NULL OR plan_studio <> NEW.studio_id THEN
            RAISE EXCEPTION 'Billing invoice item billing plan must belong to the same studio';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = public, pg_temp;
