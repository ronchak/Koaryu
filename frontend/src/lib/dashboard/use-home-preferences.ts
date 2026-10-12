"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { homeRoleClass } from "@/lib/dashboard/home-model";
import {
  homePreferencesSync,
  homeReadStartedAt,
  isDefaultHomePreferences,
  moveHomePanel,
  moveHomePanelTo,
  reconcileHomePreferences,
  resetHomePreferences,
  setHomePanelShown,
  type HomePanelId,
  type HomePreferences,
} from "@/lib/dashboard/home-preferences";
import { homeAccessScope, refuseHomeAccess } from "@/lib/dashboard/home-access";
import { useConfigStore, useDashboardStore, useStudioStore } from "@/lib/store-contexts";

/*
 * Home's preferences for the verified user and studio. First paint comes from
 * the local copy (or the role's defaults); the server's value from the Home
 * payload is adopted when it arrives unless a local edit is pending or its read
 * started before the latest confirmed save. Every edit applies at once and is
 * saved through the store's loader, debounced; Done and the page being hidden
 * flush it. The sync outlives this hook, so a save still lands after Home
 * unmounts. A refused save (401, 402, 403, 409) suspends editing and hides
 * Home's shown and retained data like a refused Home read, until a fresh read
 * succeeds. Nothing here ever shows one identity another's.
 */

export type HomePreferencesState = {
  /** Reconciled for the viewer's role. */
  preferences: HomePreferences;
  /** At the role's defaults ("Reset to defaults" is disabled). */
  isDefault: boolean;
  /** The verified identity can edit: false until then, and while a refused save is unresolved. */
  canEdit: boolean;
  move: (id: HomePanelId, offset: number) => void;
  moveTo: (id: HomePanelId, index: number) => void;
  setShown: (id: HomePanelId, shown: boolean) => void;
  reset: () => void;
  /** Sends a pending save now. */
  flush: () => void;
};

const noSubscription = () => () => {};

/** `payload` is the Home payload on screen (its `preferences` section, and when its read began). */
export function useHomePreferences(
  payload: { preferences?: unknown } | null,
): HomePreferencesState {
  const { subscriptionRequired } = useConfigStore();
  const { currentUserId, currentStudioId, currentRole, identityGeneration, identityReady } =
    useStudioStore();
  const { loadDashboardHome, saveDashboardHomePreferences } = useDashboardStore();
  const role = homeRoleClass(currentRole);
  const userId = currentUserId.trim();
  const studioId = currentStudioId?.trim() ?? "";
  const verified = identityReady && !subscriptionRequired && Boolean(userId && studioId) && role;

  const sync = useMemo(
    () => (verified && role ? homePreferencesSync({ scope: { userId, studioId }, role }) : null),
    [role, studioId, userId, verified],
  );
  const snapshot = useSyncExternalStore(
    sync ? sync.subscribe : noSubscription,
    () => sync?.getSnapshot() ?? null,
    () => null,
  );
  const suspended = useSyncExternalStore(
    sync ? sync.subscribe : noSubscription,
    () => sync?.isSuspended() ?? false,
    () => false,
  );
  // Reconciled at render too, so a role change never shows a panel for a moment.
  const preferences = useMemo(() => reconcileHomePreferences(snapshot, role), [role, snapshot]);

  useLayoutEffect(() => {
    if (sync && role) sync.setRole(role);
  }, [role, sync]);
  useEffect(() => {
    sync?.setSaver(saveDashboardHomePreferences);
  }, [saveDashboardHomePreferences, sync]);
  // Registered for the sync's lifetime, so a refusal after Home unmounts still
  // hides the retained payload before the next visit paints it.
  useEffect(() => {
    if (!sync || !role) return;
    const scope = homeAccessScope({ identityGeneration, userId, studioId, role });
    sync.setRefusalListener(() => refuseHomeAccess(loadDashboardHome, scope));
  }, [identityGeneration, loadDashboardHome, role, studioId, sync, userId]);
  useEffect(() => {
    sync?.offerServer(payload?.preferences, homeReadStartedAt(payload));
  }, [payload, sync]);
  useEffect(() => {
    if (!sync) return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") sync.flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [sync]);

  const edit = useCallback(
    (next: (current: HomePreferences) => HomePreferences) => {
      if (!sync || !role) return;
      sync.change(next(reconcileHomePreferences(sync.getSnapshot(), role)));
    },
    [role, sync],
  );
  const move = useCallback(
    (id: HomePanelId, offset: number) => edit((current) => moveHomePanel(current, id, offset)),
    [edit],
  );
  const moveTo = useCallback(
    (id: HomePanelId, index: number) => edit((current) => moveHomePanelTo(current, id, index)),
    [edit],
  );
  const setShown = useCallback(
    (id: HomePanelId, shown: boolean) => edit((current) => setHomePanelShown(current, id, shown)),
    [edit],
  );
  const reset = useCallback(() => edit(() => resetHomePreferences(role)), [edit, role]);
  const flush = useCallback(() => sync?.flush(), [sync]);

  return useMemo(
    () => ({
      preferences,
      isDefault: isDefaultHomePreferences(preferences, role),
      canEdit: sync !== null && !suspended,
      move,
      moveTo,
      setShown,
      reset,
      flush,
    }),
    [flush, move, moveTo, preferences, reset, role, setShown, suspended, sync],
  );
}
