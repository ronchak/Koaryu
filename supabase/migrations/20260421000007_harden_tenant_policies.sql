-- ==========================================
-- Koaryu v1 — Migration 007
-- Harden tenant-scoped insert/update policies
-- ==========================================

-- Studios and staff roles
DROP POLICY IF EXISTS "studios_insert_auth" ON studios;
DROP POLICY IF EXISTS "studios_insert_owner" ON studios;
CREATE POLICY "studios_insert_owner" ON studios FOR INSERT
    WITH CHECK (
        auth.uid() IS NOT NULL
        AND owner_id = auth.uid()
    );

DROP POLICY IF EXISTS "studios_update_owner" ON studios;
CREATE POLICY "studios_update_owner" ON studios FOR UPDATE
    USING (owner_id = auth.uid())
    WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS "staff_roles_insert_auth" ON staff_roles;
DROP POLICY IF EXISTS "staff_roles_insert_owner" ON staff_roles;
CREATE POLICY "staff_roles_insert_owner" ON staff_roles FOR INSERT
    WITH CHECK (
        auth.uid() IS NOT NULL
        AND user_id = auth.uid()
        AND studio_id IN (SELECT id FROM studios WHERE owner_id = auth.uid())
    );

DROP POLICY IF EXISTS "audit_logs_insert_auth" ON audit_logs;
DROP POLICY IF EXISTS "audit_logs_insert_member" ON audit_logs;
CREATE POLICY "audit_logs_insert_member" ON audit_logs FOR INSERT
    WITH CHECK (
        actor_id = auth.uid()
        AND studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid())
    );

-- Students / guardians / programs
DROP POLICY IF EXISTS "students_update" ON students;
CREATE POLICY "students_update" ON students FOR UPDATE
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()))
    WITH CHECK (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "guardians_update" ON guardians;
CREATE POLICY "guardians_update" ON guardians FOR UPDATE
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()))
    WITH CHECK (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "programs_update" ON programs;
CREATE POLICY "programs_update" ON programs FOR UPDATE
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()))
    WITH CHECK (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "student_guardians_insert" ON student_guardians;
CREATE POLICY "student_guardians_insert" ON student_guardians FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1
            FROM students s
            JOIN guardians g ON g.id = guardian_id
            WHERE s.id = student_id
              AND s.studio_id = g.studio_id
              AND s.studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid())
        )
    );

-- Schedule
DROP POLICY IF EXISTS "class_templates_insert" ON class_templates;
CREATE POLICY "class_templates_insert" ON class_templates FOR INSERT
    WITH CHECK (
        studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid())
        AND (
            program_id IS NULL
            OR EXISTS (
                SELECT 1 FROM programs p
                WHERE p.id = program_id
                  AND p.studio_id = studio_id
            )
        )
        AND (
            instructor_id IS NULL
            OR EXISTS (
                SELECT 1 FROM staff_roles sr
                WHERE sr.user_id = instructor_id
                  AND sr.studio_id = studio_id
            )
        )
    );

DROP POLICY IF EXISTS "class_templates_update" ON class_templates;
CREATE POLICY "class_templates_update" ON class_templates FOR UPDATE
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()))
    WITH CHECK (
        studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid())
        AND (
            program_id IS NULL
            OR EXISTS (
                SELECT 1 FROM programs p
                WHERE p.id = program_id
                  AND p.studio_id = studio_id
            )
        )
        AND (
            instructor_id IS NULL
            OR EXISTS (
                SELECT 1 FROM staff_roles sr
                WHERE sr.user_id = instructor_id
                  AND sr.studio_id = studio_id
            )
        )
    );

DROP POLICY IF EXISTS "class_sessions_insert" ON class_sessions;
CREATE POLICY "class_sessions_insert" ON class_sessions FOR INSERT
    WITH CHECK (
        studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid())
        AND (
            template_id IS NULL
            OR EXISTS (
                SELECT 1 FROM class_templates ct
                WHERE ct.id = template_id
                  AND ct.studio_id = studio_id
            )
        )
        AND (
            program_id IS NULL
            OR EXISTS (
                SELECT 1 FROM programs p
                WHERE p.id = program_id
                  AND p.studio_id = studio_id
            )
        )
        AND (
            instructor_id IS NULL
            OR EXISTS (
                SELECT 1 FROM staff_roles sr
                WHERE sr.user_id = instructor_id
                  AND sr.studio_id = studio_id
            )
        )
    );

DROP POLICY IF EXISTS "class_sessions_update" ON class_sessions;
CREATE POLICY "class_sessions_update" ON class_sessions FOR UPDATE
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()))
    WITH CHECK (
        studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid())
        AND (
            template_id IS NULL
            OR EXISTS (
                SELECT 1 FROM class_templates ct
                WHERE ct.id = template_id
                  AND ct.studio_id = studio_id
            )
        )
        AND (
            program_id IS NULL
            OR EXISTS (
                SELECT 1 FROM programs p
                WHERE p.id = program_id
                  AND p.studio_id = studio_id
            )
        )
        AND (
            instructor_id IS NULL
            OR EXISTS (
                SELECT 1 FROM staff_roles sr
                WHERE sr.user_id = instructor_id
                  AND sr.studio_id = studio_id
            )
        )
    );

DROP POLICY IF EXISTS "attendance_insert" ON attendance;
CREATE POLICY "attendance_insert" ON attendance FOR INSERT
    WITH CHECK (
        studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid())
        AND EXISTS (
            SELECT 1 FROM class_sessions cs
            WHERE cs.id = session_id
              AND cs.studio_id = studio_id
        )
        AND EXISTS (
            SELECT 1 FROM students s
            WHERE s.id = student_id
              AND s.studio_id = studio_id
        )
    );

DROP POLICY IF EXISTS "attendance_update" ON attendance;
CREATE POLICY "attendance_update" ON attendance FOR UPDATE
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()))
    WITH CHECK (
        studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid())
        AND EXISTS (
            SELECT 1 FROM class_sessions cs
            WHERE cs.id = session_id
              AND cs.studio_id = studio_id
        )
        AND EXISTS (
            SELECT 1 FROM students s
            WHERE s.id = student_id
              AND s.studio_id = studio_id
        )
    );

-- Belts
DROP POLICY IF EXISTS "belt_ladders_insert" ON belt_ladders;
CREATE POLICY "belt_ladders_insert" ON belt_ladders FOR INSERT
    WITH CHECK (
        studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid())
        AND (
            program_id IS NULL
            OR EXISTS (
                SELECT 1 FROM programs p
                WHERE p.id = program_id
                  AND p.studio_id = studio_id
            )
        )
    );

DROP POLICY IF EXISTS "belt_ladders_update" ON belt_ladders;
CREATE POLICY "belt_ladders_update" ON belt_ladders FOR UPDATE
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()))
    WITH CHECK (
        studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid())
        AND (
            program_id IS NULL
            OR EXISTS (
                SELECT 1 FROM programs p
                WHERE p.id = program_id
                  AND p.studio_id = studio_id
            )
        )
    );

DROP POLICY IF EXISTS "belt_ranks_insert" ON belt_ranks;
CREATE POLICY "belt_ranks_insert" ON belt_ranks FOR INSERT
    WITH CHECK (
        studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid())
        AND EXISTS (
            SELECT 1 FROM belt_ladders bl
            WHERE bl.id = ladder_id
              AND bl.studio_id = studio_id
        )
    );

DROP POLICY IF EXISTS "belt_ranks_update" ON belt_ranks;
CREATE POLICY "belt_ranks_update" ON belt_ranks FOR UPDATE
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()))
    WITH CHECK (
        studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid())
        AND EXISTS (
            SELECT 1 FROM belt_ladders bl
            WHERE bl.id = ladder_id
              AND bl.studio_id = studio_id
        )
    );

DROP POLICY IF EXISTS "promotions_insert" ON promotions;
CREATE POLICY "promotions_insert" ON promotions FOR INSERT
    WITH CHECK (
        studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid())
        AND EXISTS (
            SELECT 1 FROM students s
            WHERE s.id = student_id
              AND s.studio_id = studio_id
        )
        AND EXISTS (
            SELECT 1 FROM belt_ranks br
            WHERE br.id = to_rank_id
              AND br.studio_id = studio_id
        )
        AND (
            from_rank_id IS NULL
            OR EXISTS (
                SELECT 1 FROM belt_ranks br
                WHERE br.id = from_rank_id
                  AND br.studio_id = studio_id
            )
        )
        AND promoted_by = auth.uid()
    );

-- Leads
DROP POLICY IF EXISTS "leads_insert" ON leads;
CREATE POLICY "leads_insert" ON leads FOR INSERT
    WITH CHECK (
        studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid())
        AND (
            assigned_staff_id IS NULL
            OR EXISTS (
                SELECT 1 FROM staff_roles sr
                WHERE sr.user_id = assigned_staff_id
                  AND sr.studio_id = studio_id
            )
        )
    );

DROP POLICY IF EXISTS "leads_update" ON leads;
CREATE POLICY "leads_update" ON leads FOR UPDATE
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()))
    WITH CHECK (
        studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid())
        AND (
            assigned_staff_id IS NULL
            OR EXISTS (
                SELECT 1 FROM staff_roles sr
                WHERE sr.user_id = assigned_staff_id
                  AND sr.studio_id = studio_id
            )
        )
    );

DROP POLICY IF EXISTS "lead_activities_insert" ON lead_activities;
CREATE POLICY "lead_activities_insert" ON lead_activities FOR INSERT
    WITH CHECK (
        studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid())
        AND EXISTS (
            SELECT 1 FROM leads l
            WHERE l.id = lead_id
              AND l.studio_id = studio_id
        )
    );
