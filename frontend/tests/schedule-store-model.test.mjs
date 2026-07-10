import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  beginScheduleMutationState,
  compareSessions,
  createScheduleCoordinatorState,
  createScheduleReconciliationQueue,
  finishScheduleMutationState,
  getPreviewTemplateSessionDates,
  isScheduleReadCurrent,
  mergeAttendanceForSessions,
  mergeSessionsForRange,
  markScheduleCoordinatorSnapshotState,
  normalizeAttendanceRecords,
  resetScheduleCoordinatorState,
  shouldReconcileSchedule,
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

  it("keeps old-generation mutation finishers out of a reset coordinator", () => {
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
