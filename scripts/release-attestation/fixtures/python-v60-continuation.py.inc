            upgraded = snapshot(database)
            result = local.sql(database, (root / 'supabase/verification/mcp_read_connections_contract.sql').read_text())
            require(result == 'MCP connection ownership, audience, sessions, revocation and deletion passed', 'MCP continuation failed')
            require(snapshot(database) == upgraded, 'MCP continuation changed retained rows')
            check(database, 'V59_OPERATIONAL_READINESS_SQL', 'EXPECTED_V59_OPERATIONAL_READINESS')
            if not is_restored:
                verify_populated_mcp_restore(local, database, pg_dump, pg_restore, createdb, temporary)
            outcomes[('restored_' if is_restored else 'canonical_')+'mcp_continuation'] = result
