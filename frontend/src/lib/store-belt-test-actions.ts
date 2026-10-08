"use client";

import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import type { BeltLadder, Program, Student, EligibilityEntry } from "@/types";
import type { BeginLiveAuthRequest, StoreRef } from "./store-action-types";
import { beginResourceMutation, type ResourceScope } from "./store-resource-scope";
import { createPreviewBeltTestOwner } from "./preview-belt-test-owner";
import {
  getBrowserBeltTestOwner,
  INACTIVE_BELT_TEST_FACADE,
  type BeltTestBinding,
  type BeltTestFacade,
  type BeltTestOwner,
  type BeltTestScope,
} from "./belt-test-operation";

export function useStoreBeltTestActions(args: {
  scope: BeltTestScope | null;
  isPreviewMode: boolean;
  beginLiveAuthRequest: BeginLiveAuthRequest;
  resourceScopeRef: StoreRef<ResourceScope>;
  beltLaddersRef: StoreRef<BeltLadder[]>;
  programsRef: StoreRef<Program[]>;
  studentsRef: StoreRef<Student[]>;
  previewEligibilityForLadder: (ladderId: string) => readonly EligibilityEntry[];
}): BeltTestFacade {
  const { scope, isPreviewMode, beginLiveAuthRequest, resourceScopeRef } = args;
  const user = scope?.userId,
    studio = scope?.studioId;
  const resource = resourceScopeRef.current,
    latest = useRef(args);
  useLayoutEffect(() => {
    latest.current = args;
  });
  const [connection] = useState(() => {
    let snapshot = INACTIVE_BELT_TEST_FACADE;
    const listeners = new Set<() => void>();
    const notify = () => {
      for (const listener of listeners) listener();
    };
    return {
      getSnapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      attach(owner: Pick<BeltTestOwner, "getSnapshot" | "subscribe">) {
        const update = () => {
          snapshot = owner.getSnapshot();
          notify();
        };
        const unsubscribe = owner.subscribe(update);
        update();
        return () => {
          unsubscribe();
          snapshot = INACTIVE_BELT_TEST_FACADE;
          notify();
        };
      },
    };
  });
  const binding = useMemo<BeltTestBinding>(
    () => ({
      isCurrent: () => resourceScopeRef.current === resource,
      beginRequest: beginLiveAuthRequest,
      beginMutation: () => beginResourceMutation(resource),
      listEvents: (query, token) => api.get(`/belt-tests${query}`, token),
      event: (event, token) => api.get(`/belt-tests/${event}`, token),
      listRecipients: (event, query, token) =>
        api.get(`/belt-tests/${event}/recipients${query}`, token),
      recipient: (event, recipient, token) =>
        api.get(`/belt-tests/${event}/recipients/${recipient}`, token),
      candidates: (event, token) => api.get(`/belt-tests/${event}/candidates`, token),
      create: (body, token) => api.post("/belt-tests", body, token),
      update: (event, body, token) => api.patch(`/belt-tests/${event}`, body, token),
      approve: (event, body, token) =>
        api.post(`/belt-tests/${event}/recipients/approve`, body, token),
      revoke: (event, recipient, body, token) =>
        api.post(`/belt-tests/${event}/recipients/${recipient}/revoke`, body, token),
      receipt: (operation, token) => api.get(`/automations/operations/${operation}`, token),
    }),
    [beginLiveAuthRequest, resource, resourceScopeRef],
  );
  useLayoutEffect(() => {
    if (!isPreviewMode) return;
    let active = true;
    const owner = createPreviewBeltTestOwner(
      {
        getLadders: () => latest.current.beltLaddersRef.current,
        getPrograms: () => latest.current.programsRef.current,
        getStudents: () => latest.current.studentsRef.current,
        eligibilityForLadder: (id) => latest.current.previewEligibilityForLadder(id),
      },
      () => active && binding.isCurrent(),
    );
    const disconnect = connection.attach(owner);
    return () => {
      active = false;
      disconnect();
    };
  }, [binding, connection, isPreviewMode]);
  useLayoutEffect(() => {
    if (isPreviewMode || !user || !studio) return;
    try {
      const owner = getBrowserBeltTestOwner({ userId: user, studioId: studio, role: "admin" });
      const detach = owner.bind(binding),
        disconnect = connection.attach(owner);
      return () => {
        disconnect();
        detach();
      };
    } catch {
      /* Only current verified authority may attach a live owner. */
    }
  }, [binding, connection, isPreviewMode, user, studio]);
  const snapshot = useSyncExternalStore(
    connection.subscribe,
    connection.getSnapshot,
    () => INACTIVE_BELT_TEST_FACADE,
  );
  return isPreviewMode || scope ? snapshot : INACTIVE_BELT_TEST_FACADE;
}
