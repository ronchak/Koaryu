        require(seed == 'seeded', 'MCP predecessor fixture did not seed')
        require(any(row['id'] == '00000000-0000-4000-8000-000000006102' for row in before['public.studios']),
                'MCP restore requires a retained studio')
