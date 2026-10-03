        require(seed == "seeded" and len(before["public.student_billing_enrollments"]) == 3
                and before["public.billing_provider_operations"][0]["provider_request_attempt_count"] == 0,
                "Activation restore seed is incomplete")
