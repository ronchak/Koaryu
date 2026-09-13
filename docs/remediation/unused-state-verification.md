# Unused state verification

Base `234e46ba7bfc2787c9013de4bbb188a8100851e6`; implementation `5d0347e7ff71ea5a60af724d0e24c020d70522e8`. Fixes FSH1-08 and FSH2-10 and completes the remaining batch08 scope.

Removed dashboard new-student/churn calculations and projections that no widget consumes, unused lead drag handlers/state and the public setLadderName/setSubRankTerm commands. Their exclusive ensureCurrentLadder and preview sub-rank helper also disappear. Active internal setters, setCurrentLadder, setBeltRanks and useStore remain. No backend response, business definition, provider or database contract changed.

The coordinator verified repository-wide callers and every source/test delta. Forty surviving function/command bodies in the belt actions, lead controller and dashboard model match base, allowing only removal of calls that cleared the deleted drag state. Live lead stage changes, conversions, keyboard movement, optimistic rollback and active belt commands remain intact. Other overlapping findings about token renewal, pending eligibility, repeated loading, concurrent lead actions and follow-up semantics remain pending; this cleanup does not fix them indirectly.

Fourteen files total 6,837→6,436 lines and 225,687→214,523 bytes. Runtime source shrinks 354 lines; four test files shrink 1,148→1,101 lines and 36,492→35,162 bytes. One dead preview-helper case is deleted, with no new cases or source assertions. The focused collected count goes 80→79 and the full frontend suite 903→902.

Coordinator: 38 model cases passed. Implementer: 79 focused cases and all 902 frontend cases passed on the final contents, along with targeted lint/format and a synthetic .env.example build. No new helper, abstraction layer, dependency, app feature, SQL, provider action or production execution. Fresh independent review and exact-head CI remain required before guarded merge.
