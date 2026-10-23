            require(local.sql(database, CONTINUATION_SQL) == 'continued and replayed', 'V61 continuation/replay failed')
            check(database, 'V60_OPERATIONAL_READINESS_SQL', 'EXPECTED_V60_OPERATIONAL_READINESS')
