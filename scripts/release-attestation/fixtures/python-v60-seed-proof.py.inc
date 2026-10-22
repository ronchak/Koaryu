        require(seed == 'seeded', 'V60 source fixture did not seed')
        require(len(before['public.attendance']) >= 4 and any(row['id'] == '00000000-0000-4000-8000-000000006002'
                for row in before['public.studios']), 'V60 requires retained attendance gaps')
