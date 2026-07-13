import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  beginScheduleMutationState,
  buildScheduleRangeRequest,
  compareSessions,
  createScheduleCoordinatorState,
  createScheduleReconciliationQueue,
  finishScheduleMutationState,
  getPreviewTemplateSessionDates,
  isAuthoritativeScheduleReady,
  isScheduleRangeCommitCurrent,
  isScheduleReadCurrent,
  mergeAttendanceForSessions,
  mergeSessionsForRange,
  markScheduleCoordinatorSnapshotState,
  normalizeAttendanceRecords,
  refreshScheduleCoordinatorAuthState,
  resolveScheduleReconciliationRange,
  resetScheduleCoordinatorState,
  runScheduleRangeRefreshWithRetry,
  setScheduleRequestedRangeState,
  shouldReconcileSchedule,
  shouldPreserveScheduleMutationsOnAuthChange,
  shouldRetryScheduleReadAfterCoordinatorChange,
  toAttendanceCountDelta,
  updateSessionAttendanceCount,
} from "../src/lib/schedule-store-model.ts";

function session(id, date, startTime, overrides = {}) {
  return {
    id,
    studio_id: "studio-1",
    name: id,
    date,
    start_time: startTime,
    end_time: "18:00",
    status: "scheduled",
    created_at: "2026-05-24T00:00:00.000Z",
    attendance_count: 0,
    ...overrides,
  };
}

function attendance(id, sessionId, studentId, overrides = {}) {
  return {
    id,
    studio_id: "studio-1",
    session_id: sessionId,
    student_id: studentId,
    status: "present",
    checked_in_at: "2026-05-24T00:00:00.000Z",
    ...overrides,
  };
}

function template(overrides = {}) {
  return {
    id: "template-1",
    studio_id: "studio-1",
    name: "Kids BJJ",
    day_of_week: 1,
    start_time: "17:00",
    end_time: "18:00",
    start_date: "2026-05-04",
    is_active: true,
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("schedule store model", () => {
  it("keeps reads GET-only and requires authorized materialization intent for POST", () => {
    assert.deepEqual(
      buildScheduleRangeRequest("2026-07-01", "2026-07-31", "read", true),
      {
        method: "GET",
        path: "/schedule/sessions?start_date=2026-07-01&end_date=2026-07-31",
      }
    );
    assert.deepEqual(
      buildScheduleRangeRequest("2026-07-01", "2026-07-31", "materialize", true),
      {
        method: "POST",
        path: "/schedule/sessions/materialize?start_date=2026-07-01&end_date=2026-07-31",
      }
    );
    assert.equal(
      buildScheduleRangeRequest("2026-07-01", "2026-07-31", "materialize", false).method,
      "GET"
    );
  });

  it("rejects stale reads after a newer request or schedule mutation", () => {
    const current = {
      authCurrent: true,
      currentGeneration: 2,
      currentDataRevision: 4,
      currentRequestSequence: 7,
      dataRevisionAtStart: 4,
      generationAtStart: 2,
      mutationsInFlight: 0,
      requestSequenceAtStart: 7,
    };

    assert.equal(isScheduleReadCurrent(current), true);
    assert.equal(isScheduleReadCurrent({ ...current, authCurrent: false }), false);
    assert.equal(isScheduleReadCurrent({ ...current, currentGeneration: 3 }), false);
    assert.equal(isScheduleReadCurrent({ ...current, currentDataRevision: 5 }), false);
    assert.equal(isScheduleReadCurrent({ ...current, currentRequestSequence: 8 }), false);
    assert.equal(isScheduleReadCurrent({ ...current, mutationsInFlight: 1 }), false);
  });

  it("invalidates the authoritative snapshot while a mutation is in flight", () => {
    const initial = markScheduleCoordinatorSnapshotState(createScheduleCoordinatorState());
    const mutation = beginScheduleMutationState(initial);

    assert.equal(isAuthoritativeScheduleReady(initial), true);
    assert.equal(isAuthoritativeScheduleReady(mutation), false);
    assert.equal(mutation.hasAuthoritativeSnapshot, false);
    assert.equal(mutation.mutationsInFlight, 1);
    assert.equal(shouldReconcileSchedule(mutation), false);

    const settled = finishScheduleMutationState(mutation, mutation.generation);
    assert.equal(isAuthoritativeScheduleReady(settled), false);
    assert.equal(settled.mutationsInFlight, 0);
    assert.equal(shouldReconcileSchedule(settled), true);
  });

  it("keeps old-generation mutation finishers out of a destructive reset coordinator", () => {
    const initial = createScheduleCoordinatorState();
    const oldMutation = beginScheduleMutationState(initial);
    const reset = resetScheduleCoordinatorState(oldMutation);
    const newMutation = beginScheduleMutationState(reset);

    const afterOldFinisher = finishScheduleMutationState(newMutation, oldMutation.generation);
    assert.equal(afterOldFinisher, newMutation);
    assert.equal(afterOldFinisher.mutationsInFlight, 1);

    const afterNewFinisher = finishScheduleMutationState(
      afterOldFinisher,
      newMutation.generation
    );
    assert.equal(afterNewFinisher.mutationsInFlight, 0);
    assert.equal(afterNewFinisher.dataRevision, newMutation.dataRevision + 1);
  });

  it("reconciles a mutation that commits across an auth token refresh", () => {
    const initial = markScheduleCoordinatorSnapshotState(createScheduleCoordinatorState());
    const oldTokenMutation = beginScheduleMutationState(initial);
    const refreshedAuth = refreshScheduleCoordinatorAuthState(oldTokenMutation);

    assert.equal(refreshedAuth.generation, oldTokenMutation.generation + 1);
    assert.equal(refreshedAuth.mutationsInFlight, 1);
    assert.equal(refreshedAuth.hasAuthoritativeSnapshot, false);
    assert.equal(shouldReconcileSchedule(refreshedAuth), false);

    const settled = finishScheduleMutationState(
      refreshedAuth,
      oldTokenMutation.generation
    );
    assert.equal(settled.mutationsInFlight, 0);
    assert.equal(shouldReconcileSchedule(settled), true);
  });

  it("reconciles the latest requested range even when it is beyond the default window", () => {
    const farFutureRange = { startDate: "2027-01-01", endDate: "2027-01-31" };
    const coordinator = setScheduleRequestedRangeState(
      createScheduleCoordinatorState(),
      farFutureRange
    );

    assert.deepEqual(
      resolveScheduleReconciliationRange(coordinator, {
        startDate: "2026-06-09",
        endDate: "2026-09-07",
      }),
      farFutureRange
    );
    assert.equal(
      resetScheduleCoordinatorState(coordinator).requestedRange,
      null
    );
    assert.deepEqual(
      refreshScheduleCoordinatorAuthState(coordinator).requestedRange,
      farFutureRange
    );
  });

  it("retries range and attendance supersession before claiming a committed range", async () => {
    assert.equal(isScheduleRangeCommitCurrent(false, true), false);
    assert.equal(isScheduleRangeCommitCurrent(true, false), false);
    assert.equal(isScheduleRangeCommitCurrent(true, true), true);

    const outcomes = [
      { committed: false, value: "range-superseded" },
      { committed: false, value: "attendance-superseded" },
      { committed: true, value: "complete-range" },
    ];
    let attempts = 0;
    const value = await runScheduleRangeRefreshWithRetry(async () => {
      const result = outcomes[attempts];
      attempts += 1;
      return result;
    });

    assert.equal(value, "complete-range");
    assert.equal(attempts, 3);
  });

  it("waits for an in-flight mutation before spending a range attempt", async () => {
    let releaseSettlement;
    const settlement = new Promise((resolve) => {
      releaseSettlement = resolve;
    });
    let attempts = 0;
    let settled = false;

    const refresh = runScheduleRangeRefreshWithRetry(
      async () => {
        attempts += 1;
        return { committed: true, value: "settled-range" };
      },
      3,
      () => settlement
    ).then((value) => {
      settled = true;
      return value;
    });

    await Promise.resolve();
    assert.equal(attempts, 0);
    assert.equal(settled, false);

    releaseSettlement();
    assert.equal(await refresh, "settled-range");
    assert.equal(attempts, 1);
  });

  it("waits again when a mutation supersedes an active range read", async () => {
    let releaseSecondSettlement;
    const secondSettlement = new Promise((resolve) => {
      releaseSecondSettlement = resolve;
    });
    let gateCalls = 0;
    let attempts = 0;

    const refresh = runScheduleRangeRefreshWithRetry(
      async () => {
        attempts += 1;
        return attempts === 1
          ? { committed: false, value: "superseded" }
          : { committed: true, value: "complete-range" };
      },
      3,
      () => {
        gateCalls += 1;
        return gateCalls === 1 ? Promise.resolve() : secondSettlement;
      }
    );

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, 1);
    assert.equal(gateCalls, 2);

    releaseSecondSettlement();
    assert.equal(await refresh, "complete-range");
    assert.equal(attempts, 2);
  });

  it("fails closed when a range remains superseded", async () => {
    await assert.rejects(
      runScheduleRangeRefreshWithRetry(async () => ({ committed: false, value: [] }), 2),
      /superseded/
    );
  });

  it("preserves mutations only for a same-user token refresh", () => {
    assert.equal(
      shouldPreserveScheduleMutationsOnAuthChange("TOKEN_REFRESHED", "user-1", "user-1"),
      true
    );
    assert.equal(
      shouldPreserveScheduleMutationsOnAuthChange("SIGNED_IN", "user-1", "user-1"),
      false
    );
    assert.equal(
      shouldPreserveScheduleMutationsOnAuthChange("TOKEN_REFRESHED", "user-1", "user-2"),
      false
    );
    assert.equal(
      shouldPreserveScheduleMutationsOnAuthChange("TOKEN_REFRESHED", null, "user-1"),
      false
    );
  });

  it("retries superseded attendance reads after auth or generation changes", () => {
    assert.equal(shouldRetryScheduleReadAfterCoordinatorChange(false, true), true);
    assert.equal(shouldRetryScheduleReadAfterCoordinatorChange(true, false), true);
    assert.equal(shouldRetryScheduleReadAfterCoordinatorChange(true, true), false);
  });

  it("requests reconciliation after an initial mutation until a full snapshot lands", () => {
    const mutation = beginScheduleMutationState(createScheduleCoordinatorState());
    const settled = finishScheduleMutationState(mutation, mutation.generation);

    assert.equal(shouldReconcileSchedule(settled), true);
    const reconciled = markScheduleCoordinatorSnapshotState(settled);
    assert.equal(shouldReconcileSchedule(reconciled), false);
    assert.equal(reconciled.hasAuthoritativeSnapshot, true);
  });

  it("replays an in-flight authoritative reconciliation when a scoped read supersedes it", async () => {
    const requestReconciliation = createScheduleReconciliationQueue();
    let authoritative = false;
    let releaseFirstAttempt;
    let attempts = 0;
    const firstAttemptBlocked = new Promise((resolve) => {
      releaseFirstAttempt = resolve;
    });
    const attempt = async () => {
      attempts += 1;
      if (attempts === 1) {
        await firstAttemptBlocked;
        return;
      }
      authoritative = true;
    };
    const shouldRun = () => !authoritative;

    const initial = requestReconciliation(attempt, shouldRun);
    const replacement = requestReconciliation(attempt, shouldRun);
    releaseFirstAttempt();
    await Promise.all([initial, replacement]);

    assert.equal(attempts, 2);
    assert.equal(authoritative, true);
  });

  it("does not let a later read replace materialization queued behind a blocked read", async () => {
    const requestReconciliation = createScheduleReconciliationQueue();
    const calls = [];
    let releaseRead;
    let markReadStarted;
    const readStarted = new Promise((resolve) => {
      markReadStarted = resolve;
    });
    const readBlocked = new Promise((resolve) => {
      releaseRead = resolve;
    });

    const initialRead = requestReconciliation(async () => {
      calls.push("initial-read");
      markReadStarted();
      await readBlocked;
    }, () => true, "read");
    await readStarted;
    const materialize = requestReconciliation(async () => {
      calls.push("materialize");
    }, () => true, "materialize");
    const laterRead = requestReconciliation(async () => {
      calls.push("later-read");
    }, () => true, "read");

    releaseRead();
    await Promise.all([initialRead, materialize, laterRead]);

    assert.deepEqual(calls, ["initial-read", "materialize"]);
  });

  it("runs queued materialization after an active read satisfies the ordinary guard", async () => {
    const requestReconciliation = createScheduleReconciliationQueue();
    const calls = [];
    let authoritative = false;
    let releaseRead;
    let markReadStarted;
    const readStarted = new Promise((resolve) => {
      markReadStarted = resolve;
    });
    const readBlocked = new Promise((resolve) => {
      releaseRead = resolve;
    });

    const read = requestReconciliation(async () => {
      calls.push("read");
      markReadStarted();
      await readBlocked;
      authoritative = true;
    }, () => !authoritative, "read");
    await readStarted;
    const materialize = requestReconciliation(async () => {
      calls.push("materialize");
    }, () => !authoritative, "materialize");

    releaseRead();
    await Promise.all([read, materialize]);

    assert.deepEqual(calls, ["read", "materialize"]);
  });

  it("defers forced materialization until mutation safety is restored", async () => {
    const requestReconciliation = createScheduleReconciliationQueue();
    const calls = [];
    let authoritative = false;
    let mutationSettled = true;
    let releaseRead;
    let markReadStarted;
    const readStarted = new Promise((resolve) => {
      markReadStarted = resolve;
    });
    const readBlocked = new Promise((resolve) => {
      releaseRead = resolve;
    });
    const isExecutionSafe = () => mutationSettled;

    const read = requestReconciliation(async () => {
      calls.push("read");
      markReadStarted();
      await readBlocked;
      authoritative = true;
    }, () => !authoritative, "read", isExecutionSafe);
    await readStarted;
    const forcedMaterialize = requestReconciliation(async () => {
      calls.push("materialize-during-mutation");
    }, () => !authoritative, "materialize", isExecutionSafe);

    mutationSettled = false;
    releaseRead();
    await Promise.all([read, forcedMaterialize]);
    assert.deepEqual(calls, ["read"]);

    mutationSettled = true;
    await requestReconciliation(async () => {
      calls.push("materialize-after-settlement");
    }, () => !authoritative, "materialize", isExecutionSafe);

    assert.deepEqual(calls, ["read", "materialize-after-settlement"]);
  });

  it("discards deferred materialization after a destructive generation change", async () => {
    const requestReconciliation = createScheduleReconciliationQueue();
    const calls = [];
    let mutationSettled = true;
    let releaseRead;
    let markReadStarted;
    const readStarted = new Promise((resolve) => {
      markReadStarted = resolve;
    });
    const readBlocked = new Promise((resolve) => {
      releaseRead = resolve;
    });
    const isExecutionSafe = () => mutationSettled;

    const oldRead = requestReconciliation(async () => {
      calls.push("old-read");
      markReadStarted();
      await readBlocked;
    }, () => true, "read", isExecutionSafe, 1);
    await readStarted;
    const oldMaterialize = requestReconciliation(async () => {
      calls.push("old-materialize");
    }, () => true, "materialize", isExecutionSafe, 1);

    mutationSettled = false;
    releaseRead();
    await Promise.all([oldRead, oldMaterialize]);
    assert.deepEqual(calls, ["old-read"]);

    mutationSettled = true;
    await requestReconciliation(async () => {
      calls.push("new-auth-read");
    }, () => true, "read", isExecutionSafe, 2);

    assert.deepEqual(calls, ["old-read", "new-auth-read"]);
  });

  it("preserves deferred materialization across a same-generation token refresh", async () => {
    const requestReconciliation = createScheduleReconciliationQueue();
    const calls = [];
    let mutationSettled = true;
    let releaseRead;
    let markReadStarted;
    const readStarted = new Promise((resolve) => {
      markReadStarted = resolve;
    });
    const readBlocked = new Promise((resolve) => {
      releaseRead = resolve;
    });
    const isExecutionSafe = () => mutationSettled;

    const read = requestReconciliation(async () => {
      calls.push("read-before-refresh");
      markReadStarted();
      await readBlocked;
    }, () => true, "read", isExecutionSafe, 7);
    await readStarted;
    const materialize = requestReconciliation(async () => {
      calls.push("materialize-after-refresh");
    }, () => true, "materialize", isExecutionSafe, 7);

    mutationSettled = false;
    releaseRead();
    await Promise.all([read, materialize]);
    assert.deepEqual(calls, ["read-before-refresh"]);

    mutationSettled = true;
    await requestReconciliation(async () => {
      calls.push("same-user-auth-read");
    }, () => true, "read", isExecutionSafe, 7);

    assert.deepEqual(calls, ["read-before-refresh", "materialize-after-refresh"]);
  });

  it("does not let an unsafe old active request restore itself over a newer generation", async () => {
    const requestReconciliation = createScheduleReconciliationQueue();
    const calls = [];
    const oldMaterialize = requestReconciliation(async () => {
      calls.push("old-materialize");
    }, () => true, "materialize", () => false, 1);
    const newRead = requestReconciliation(async () => {
      calls.push("new-read");
    }, () => true, "read", () => true, 2);

    await Promise.all([oldMaterialize, newRead]);

    assert.deepEqual(calls, ["new-read"]);
  });

  it("uses the latest reconciliation attempt after an auth generation changes", async () => {
    const requestReconciliation = createScheduleReconciliationQueue();
    let generation = 1;
    let reconciledGeneration = 0;
    let releaseOldGeneration;
    const oldGenerationBlocked = new Promise((resolve) => {
      releaseOldGeneration = resolve;
    });
    const oldAttempt = async () => {
      await oldGenerationBlocked;
    };

    const initial = requestReconciliation(oldAttempt, () => reconciledGeneration !== generation);
    generation = 2;
    const refreshed = requestReconciliation(
      async () => {
        reconciledGeneration = generation;
      },
      () => reconciledGeneration !== generation
    );
    releaseOldGeneration();
    await Promise.all([initial, refreshed]);

    assert.equal(reconciledGeneration, 2);
  });

  it("runs a queued replacement after the active reconciliation rejects", async () => {
    const requestReconciliation = createScheduleReconciliationQueue();
    let releaseFailingAttempt;
    let markFailingAttemptStarted;
    let attempts = 0;
    let authoritative = false;
    const failingAttemptStarted = new Promise((resolve) => {
      markFailingAttemptStarted = resolve;
    });
    const failingAttemptBlocked = new Promise((resolve) => {
      releaseFailingAttempt = resolve;
    });

    const initial = requestReconciliation(async () => {
      attempts += 1;
      markFailingAttemptStarted();
      await failingAttemptBlocked;
      throw new Error("old token rejected");
    }, () => !authoritative);
    await failingAttemptStarted;
    const replacement = requestReconciliation(async () => {
      attempts += 1;
      authoritative = true;
    }, () => !authoritative);
    releaseFailingAttempt();
    await Promise.all([initial, replacement]);

    assert.equal(attempts, 2);
    assert.equal(authoritative, true);
  });

  it("surfaces an un-replaced reconciliation failure and accepts a later retry", async () => {
    const requestReconciliation = createScheduleReconciliationQueue();
    let attempts = 0;

    await assert.rejects(
      requestReconciliation(async () => {
        attempts += 1;
        throw new Error("network unavailable");
      }, () => true),
      /network unavailable/
    );
    await requestReconciliation(async () => {
      attempts += 1;
    }, () => true);

    assert.equal(attempts, 2);
  });

  it("does not retain a completed no-op reconciliation as in flight", async () => {
    const requestReconciliation = createScheduleReconciliationQueue();
    let attempts = 0;

    await requestReconciliation(async () => {
      attempts += 1;
    }, () => false);
    await requestReconciliation(async () => {
      attempts += 1;
    }, () => true);

    assert.equal(attempts, 1);
  });

  it("merges refreshed sessions by replacing only the requested date range", () => {
    const current = [
      session("before", "2026-05-01", "18:00"),
      session("old-in-range", "2026-05-10", "18:00"),
      session("after", "2026-05-30", "18:00"),
    ];
    const fetched = [
      session("new-late", "2026-05-10", "19:00"),
      session("new-early", "2026-05-10", "16:00"),
    ];

    const merged = mergeSessionsForRange(current, fetched, "2026-05-05", "2026-05-20");

    assert.deepEqual(merged.map((item) => item.id), ["before", "new-early", "new-late", "after"]);
    assert.equal(compareSessions(session("a", "2026-05-01", "18:00"), session("b", "2026-05-01", "19:00")) < 0, true);
  });

  it("replaces attendance for fetched sessions and normalizes missing student names", () => {
    const current = [
      attendance("old-1", "session-1", "student-1"),
      attendance("old-2", "session-2", "student-2"),
    ];
    const fetched = normalizeAttendanceRecords([
      attendance("new-1", "session-1", "student-3", { student_name: undefined }),
    ]);

    const merged = mergeAttendanceForSessions(current, fetched, ["session-1"]);

    assert.deepEqual(merged.map((item) => [item.id, item.session_id, item.student_name]), [
      ["old-2", "session-2", undefined],
      ["new-1", "session-1", ""],
    ]);
  });

  it("updates session attendance counts with status deltas and a zero floor", () => {
    assert.equal(toAttendanceCountDelta(null, "present"), 1);
    assert.equal(toAttendanceCountDelta("late", "absent"), -1);
    assert.equal(toAttendanceCountDelta("present", "late"), 0);

    const sessions = [session("session-1", "2026-05-10", "18:00", { attendance_count: 0 })];
    assert.equal(updateSessionAttendanceCount(sessions, "session-1", -1)[0].attendance_count, 0);
    assert.equal(updateSessionAttendanceCount(sessions, "session-1", 2)[0].attendance_count, 2);
    assert.equal(updateSessionAttendanceCount(sessions, "session-1", 0), sessions);
  });

  it("builds preview recurring session dates through the template end date", () => {
    assert.deepEqual(
      getPreviewTemplateSessionDates(template({ start_date: "2026-05-04", end_date: "2026-05-18" })),
      ["2026-05-04", "2026-05-11", "2026-05-18"]
    );
    assert.equal(getPreviewTemplateSessionDates(template({ start_date: "2026-05-04" })).length, 13);
  });
});
