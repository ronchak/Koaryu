SEED_SQL = r"""
BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES('00000000-0000-4000-8000-000000005901','authenticated','authenticated',
       'v59-restore@example.invalid','{}','{}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id,timezone)
VALUES('00000000-0000-4000-8000-000000005902','V59 retained timezone','v59-retained-timezone',
       '00000000-0000-4000-8000-000000005901','America/Los_Angeles');
COMMIT;
SELECT 'seeded';
"""


def require_v59_snapshot(before, after):
    expected = json.loads(json.dumps(before))
    rows = expected['private.koaryu_release_v31_expectations']
    require(len(rows) == 1 and rows[0]['expectation_key'] == 'operational_contract_v31'
            and rows[0]['expected_sha256'] == 'af3435a9266c9b482f7933dfc6ff5a756ec71fcf9eb7f3cba481e816226e50cb',
            'V59 requires the exact V58 singleton')
    rows[0]['expected_sha256'] = V59_EXPECTATION
    return after == expected

V59_EXPECTATION = '1513ff10defced0c619f85c7927259165f6c9eb7ef1400be076f567fd39c85b3'
