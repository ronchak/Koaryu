        require(seed == 'seeded', 'V59 source fixture did not seed')
        require(any(row['id'] == '00000000-0000-4000-8000-000000005902'
                    and row['timezone'] == 'America/Los_Angeles' for row in before['public.studios']),
                'V59 requires a retained named timezone')
