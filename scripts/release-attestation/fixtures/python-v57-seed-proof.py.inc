        require(seed == "seeded" and len(before["public.automation_deliveries"]) == 2,
                "V56 retained delivery fixture incomplete")
        require({row["state"] for row in before["public.automation_deliveries"]} == {"accepted", "unknown"},
                "V56 fixture must retain original accepted and uncertain delivery truth")
        require(len(before["private.automation_email_credentials"]) == 1,
                "V56 encrypted credential revision fixture absent")
        require(local.sql(source, HOSTED_LEGACY_GRANTS_SQL) == str(len(HOSTED_LEGACY_TRIGGER_FUNCTIONS)),
                "V56 predecessor must model hosted legacy service_role trigger-function grants")
