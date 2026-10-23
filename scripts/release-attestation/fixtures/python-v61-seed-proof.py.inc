        require(seed.endswith('seeded'), 'V61 source fixture did not seed')
        require(any(row['id'] == '00000000-0000-4000-8000-000000006104' for row in before['public.students'])
                and before['public.guardians'] and before['public.student_guardians']
                and before['private.student_import_receipts'], 'V61 requires populated retained import rows')
