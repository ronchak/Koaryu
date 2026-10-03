        require(sql(restored, f"SELECT count(*)=2 AND bool_and(command_fingerprint IS NULL AND command_program_id IS NULL "
            f"AND command_membership_id IS NULL AND command_from_rank_id IS NULL) FROM public.promotions WHERE studio_id='{STUDIO}';") == "t",
            "V40 fabricated evidence for legacy receipts")
