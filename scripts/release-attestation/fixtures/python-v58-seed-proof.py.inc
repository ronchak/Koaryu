        require(seed == "seeded", "V57 pilot history fixture did not seed")
        require(len(before["public.stripe_connect_onboarding_bootstraps"]) == 1
                and before["public.stripe_connect_onboarding_bootstraps"][0]["reconciliation_checkpoint_id"] is not None,
                "Restore requires an actual legacy incomplete bootstrap")
        require(len(before["public.studio_live_billing_authorizations"]) == 2
                and len(before["public.stripe_live_billing_reconciliation_checkpoints"]) == 2,
                "Restore requires retained expired grants and checkpoints")
