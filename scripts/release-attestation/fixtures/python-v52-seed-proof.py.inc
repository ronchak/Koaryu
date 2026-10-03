        require(seed == "seeded" and len(before["public.leads"]) == 1
                and len(before["public.lead_activities"]) == 1,
                "Retained lead and activity fixture is incomplete")
