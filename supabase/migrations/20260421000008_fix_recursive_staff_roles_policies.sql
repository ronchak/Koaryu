-- ==========================================
-- Koaryu v1 — Migration 008
-- Remove recursive staff_roles RLS policy
-- ==========================================

DROP POLICY IF EXISTS "staff_roles_select_own" ON staff_roles;
DROP POLICY IF EXISTS "staff_roles_select_self" ON staff_roles;

CREATE POLICY "staff_roles_select_self" ON staff_roles FOR SELECT
    USING (user_id = auth.uid());
