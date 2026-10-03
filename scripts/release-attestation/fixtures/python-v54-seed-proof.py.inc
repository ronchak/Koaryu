        require(seed == "seeded" and len(before["public.students"]) == 5
                and len(before["public.leads"]) == 4 and len(before["public.guardians"]) == 1
                and len(before["public.student_guardians"]) == 2,
                "Retained minor, guardian, adult and legacy birthdate fixture is incomplete")
        require(next(row for row in before["public.students"] if row["legal_first_name"] == "Converted")["is_minor"] is False,
                "V53 fixture no longer reproduces lost explicit minor knowledge")
