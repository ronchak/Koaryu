        require(seed == "seeded" and len(before["public.leads"]) == 1
                and len(before["public.students"]) == 1 and len(before["public.student_guardians"]) == 1,
                "Retained converted lead fixture is incomplete")
        lead = before["public.leads"][0]
        actor = before["public.staff_roles"][0]["user_id"]
        old_result = json.loads(local.sql(source, f"SELECT to_jsonb(public.convert_lead_to_student_atomic('{lead['studio_id']}','{actor}','{lead['id']}','{lead['converted_student_id']}','{lead['program_id']}','active',CURRENT_DATE,NULL,NULL));"))
        require(old_result["stage"] == "offer_sent" and snapshot(source) == before,
                "V54 source no longer reproduces the converted-stage restoration bug")
        require(before["public.students"][0]["date_of_birth"] is None
                and before["public.students"][0]["is_minor"] is True,
                "V54 seed lost explicit minor knowledge without a DOB")
