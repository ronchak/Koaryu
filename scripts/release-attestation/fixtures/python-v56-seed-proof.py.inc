        require(seed == "seeded" and len(before["public.leads"]) == 1
                and len(before["public.students"]) == 4 and len(before["public.student_guardians"]) == 2
                and len(before["public.attendance"]) == 3,
                "V55 retained lead and automation eligibility fixtures are incomplete")
        require(local.sql(source, "SELECT to_regclass('public.automation_rules') IS NULL AND "
                          "to_regclass('private.automation_email_credentials') IS NULL;") == "t",
                "V55 source already has automation tables")
