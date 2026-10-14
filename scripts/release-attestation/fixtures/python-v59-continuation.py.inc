            upgraded = snapshot(database)
            result = local.sql(database, (root / 'supabase/verification/timezone_names_reference_contract.sql').read_text())
            require(snapshot(database) == upgraded, 'Timezone continuation changed retained rows')
            outcomes[('restored_' if is_restored else 'canonical_') + 'timezone_continuation'] = result
