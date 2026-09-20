BEGIN;

DO $terms$
DECLARE
    actor UUID:=gen_random_uuid(); studio UUID:=gen_random_uuid(); payer UUID:=gen_random_uuid();
    known UUID:=gen_random_uuid(); unknown_a UUID:=gen_random_uuid(); unknown_b UUID:=gen_random_uuid();
    account TEXT:='acct_Terms'||replace(studio::TEXT,'-','');
    before_known JSONB;
    rejected BOOLEAN:=FALSE;
    rejected_constraint TEXT;
BEGIN
    INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(actor,'authenticated','authenticated',actor||'@example.invalid','{}','{}',now(),now());
    INSERT INTO public.studios(id,name,slug,owner_id) VALUES(studio,'Terms fixture',studio::TEXT,actor);
    INSERT INTO public.studio_payment_accounts(studio_id,stripe_connected_account_id,status,charges_enabled,payouts_enabled,metadata)
    VALUES(studio,account,'charges_enabled',TRUE,TRUE,'{"connect_account_generation":1}');
    INSERT INTO public.billing_payers(id,studio_id,display_name,stripe_account_id,stripe_customer_id,connect_account_generation)
    VALUES(payer,studio,'Terms payer',account,'cus_Terms',1);
    INSERT INTO public.billing_subscriptions(id,studio_id,payer_id,stripe_account_id,stripe_customer_id,
        stripe_subscription_id,collection_mode,billing_interval,currency,status)
    VALUES(known,studio,payer,account,'cus_Terms','sub_TermsKnown','invoice_link','monthly','usd','active');
    SELECT to_jsonb(s) INTO before_known FROM public.billing_subscriptions s WHERE id=known;

    -- Omission and explicit unknown must both remain unknown, with distinct provider identities.
    INSERT INTO public.billing_subscriptions(id,studio_id,payer_id,stripe_account_id,stripe_customer_id,
        stripe_subscription_id,collection_mode,status)
    VALUES(unknown_a,studio,payer,account,'cus_Terms','sub_TermsUnknownA','invoice_link','active');
    INSERT INTO public.billing_subscriptions(id,studio_id,payer_id,stripe_account_id,stripe_customer_id,
        stripe_subscription_id,collection_mode,billing_interval,currency,status)
    VALUES(unknown_b,studio,payer,account,'cus_Terms','sub_TermsUnknownB','invoice_link',NULL,NULL,'active');
    IF (SELECT count(*) FROM public.billing_subscriptions
        WHERE id IN (unknown_a,unknown_b) AND currency IS NULL AND billing_interval IS NULL)
        IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION 'Unknown provider terms acquired invented defaults.';
    END IF;
    IF (SELECT array_agg(id) FROM public.billing_subscriptions
        WHERE studio_id=studio AND payer_id=payer AND collection_mode='invoice_link'
          AND currency='usd' AND billing_interval='monthly' AND status='active')
        IS DISTINCT FROM ARRAY[known] THEN
        RAISE EXCEPTION 'Unknown terms joined the known USD monthly group.';
    END IF;
    BEGIN
        INSERT INTO public.billing_subscriptions(studio_id,payer_id,stripe_account_id,stripe_customer_id,
            stripe_subscription_id,collection_mode,status)
        VALUES(studio,payer,account,'cus_Terms','sub_TermsUnknownA','invoice_link','active');
    EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS rejected_constraint=CONSTRAINT_NAME;
        IF rejected_constraint<>'idx_billing_subscriptions_stripe' THEN RAISE; END IF;
        rejected:=TRUE;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'Unknown terms bypassed provider identity uniqueness.'; END IF;
    UPDATE public.billing_subscriptions SET currency='eur',billing_interval='weekly' WHERE id=unknown_a;
    IF (SELECT (currency,billing_interval) FROM public.billing_subscriptions WHERE id=unknown_a)
        IS DISTINCT FROM ROW('eur'::TEXT,'weekly'::TEXT)
       OR (SELECT to_jsonb(s) FROM public.billing_subscriptions s WHERE id=known)
        IS DISTINCT FROM before_known THEN
        RAISE EXCEPTION 'Confirmed terms did not fill the unknown row independently.';
    END IF;
END;
$terms$;

ROLLBACK;
