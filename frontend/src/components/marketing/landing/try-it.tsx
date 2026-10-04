"use client";

import {
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Repeat2,
  RotateCcw,
  UserPlus,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { MartialArtsBelt } from "@/components/icons/martial-arts-belt";

import {
  landingPageContent,
  type BeltRank,
  type DemoLead,
  type DemoLeadSource,
  type DemoStudent,
} from "../../../lib/landing-page-content.ts";
import s from "./try.module.css";
import {
  BELT_LABELS,
  LEAD_BANDS,
  MARK_LABELS,
  SOURCE_LABELS,
  STAGES,
  beltRegister,
  createTryReducer,
  describeChange,
  followUpLabel,
  initialTryState,
  initials,
  leadBand,
  leadTotals,
  nextAction,
  sessionSummary,
  stageCounts,
  studentProgress,
  tasksDone,
  weekday,
  type Mark,
  type TaskId,
  type TryAction,
  type TryState,
} from "./try-model";

const { studio } = landingPageContent;
const STUDENTS: readonly DemoStudent[] = studio.students;
const LEADS: readonly DemoLead[] = studio.leads;
const reducer = createTryReducer(STUDENTS, LEADS);
const BELT_ORDER: readonly BeltRank[] = ["white", "yellow", "orange", "green"];

type View = "class" | "belts" | "leads";
type Sheet = { kind: "card"; id: string } | { kind: "lead" } | null;
type Toast = { key: number; kind: "ready" | "lead"; text: string } | null;

const VIEWS: readonly { id: View; label: string; icon: ReactNode }[] = [
  { id: "class", label: "Schedule", icon: <Calendar aria-hidden="true" /> },
  { id: "belts", label: "Belt Tracker", icon: <MartialArtsBelt aria-hidden="true" /> },
  { id: "leads", label: "Leads", icon: <UserPlus aria-hidden="true" /> },
];

/* ------------------------------------------------------------------ Pieces */

function RankBadge({ belt }: { belt: BeltRank }) {
  return (
    <span className={s.rank} data-belt={belt}>
      <span className={s.rankDot} aria-hidden="true" />
      {BELT_LABELS[belt]}
    </span>
  );
}

function Bar({
  current,
  required,
  label,
  unit = "",
}: {
  current: number;
  required: number;
  label: string;
  unit?: string;
}) {
  const met = current >= required;
  return (
    <span className={s.bar} data-met={met}>
      <span
        className={s.barTrack}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={required}
        aria-valuenow={Math.min(current, required)}
        aria-valuetext={`${current} of ${required}${unit}`}
      >
        <span
          className={s.barFill}
          style={{ "--fill": Math.min(1, current / required) } as CSSProperties}
        />
      </span>
      <span className={s.barTally} aria-hidden="true">
        <span key={current} className={s.tick}>
          {current}
        </span>
        /{required}
      </span>
    </span>
  );
}

function MarkIcon({ mark }: { mark: Mark }) {
  if (mark === "absent") return <X aria-hidden="true" />;
  if (mark === "late") return <Clock aria-hidden="true" />;
  return <Check aria-hidden="true" />;
}

function Count({ value }: { value: number }) {
  return (
    <span key={value} className={s.tick}>
      {value}
    </span>
  );
}

/* ------------------------------------------------------------------ Card */

function StudentCard({
  student,
  mark,
  titleId,
  titleRef,
}: {
  student: DemoStudent;
  mark: Mark;
  titleId: string;
  titleRef?: React.Ref<HTMLHeadingElement>;
}) {
  const progress = studentProgress(student, mark);
  const ready = progress.standing === "ready";
  const tonight = mark === "unmarked" ? null : mark;
  return (
    <div className={s.card} data-ready={ready}>
      <div className={s.cardHead}>
        <span className={s.cardAvatar} aria-hidden="true">
          {initials(student.name)}
        </span>
        <div>
          <h4 id={titleId} ref={titleRef} tabIndex={-1} className={s.cardName}>
            {student.name}
          </h4>
          <p className={s.cardMeta}>Minor · {studio.session.name}</p>
        </div>
        <span className={s.active}>
          <span aria-hidden="true" />
          Active
        </span>
      </div>
      {ready ? (
        <p key="ready" className={s.cardReady}>
          <Check aria-hidden="true" />
          Ready to test for {BELT_LABELS[student.nextBelt]}
        </p>
      ) : null}
      <dl className={s.cardRanks}>
        <div>
          <dt>Current rank</dt>
          <dd>
            <RankBadge belt={student.belt} />
          </dd>
        </div>
        <div>
          <dt>Next rank</dt>
          <dd>
            <RankBadge belt={student.nextBelt} />
          </dd>
        </div>
      </dl>
      <div className={s.cardReqs}>
        <p className={s.cardLabel}>Requirements</p>
        <div className={s.req}>
          <span>Classes</span>
          <Bar current={progress.classes} required={student.required} label="Classes" />
        </div>
        <div className={s.req}>
          <span>Time at rank</span>
          <Bar
            current={student.daysAtRank}
            required={student.daysRequired}
            label="Days at rank"
            unit=" days"
          />
        </div>
        <div className={s.req}>
          <span>Approval</span>
          <span className={s.reqNote}>
            {student.needsApproval ? "Instructor sign-off" : "Not required"}
          </span>
        </div>
      </div>
      <div className={s.cardHistory}>
        <p className={s.cardLabel}>Recent classes</p>
        <ol aria-label="Recent attendance, oldest first">
          {student.history.map((entry, index) => (
            <li key={index} data-mark={entry} title={MARK_LABELS[entry]}>
              <span className="sr-only">{MARK_LABELS[entry]}</span>
            </li>
          ))}
          <li data-mark={tonight ?? "unmarked"} data-tonight="true">
            <span className="sr-only">
              Tonight: {tonight ? MARK_LABELS[tonight] : "not marked"}
            </span>
          </li>
        </ol>
      </div>
      <p className={s.cardFoot}>
        {ready ? studio.ready.decision : `Guardian: ${student.guardian}`}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ Views */

function ClassView({
  state,
  selected,
  onCycle,
  onFocusStudent,
  onOpenCard,
  quickTitleRef,
  rowRefs,
}: {
  state: TryState;
  selected: string;
  onCycle: (id: string) => void;
  onFocusStudent: (id: string) => void;
  onOpenCard: (id: string, opener: HTMLElement) => void;
  quickTitleRef: React.Ref<HTMLHeadingElement>;
  rowRefs: React.RefObject<Map<string, HTMLButtonElement>>;
}) {
  const summary = sessionSummary(state.marks);
  // The session sheet counts against tonight's roster, the same students listed below.
  const capacity = STUDENTS.length;
  const quickStudent = STUDENTS.find((student) => student.id === selected) ?? STUDENTS[0];
  return (
    <div className={s.page}>
      <header className={s.pageHead}>
        <div>
          <h3 className={s.pageTitle}>
            {studio.session.name} <span className={s.pill}>Scheduled</span>
          </h3>
          <p className={s.meta}>
            <span>
              <Calendar aria-hidden="true" />
              {studio.session.day}
            </span>
            <span>
              <Clock aria-hidden="true" />
              {studio.session.time}
            </span>
            <span>
              <span className={s.programSwatch} aria-hidden="true" />
              {studio.programs[0]}
            </span>
            <span data-optional="true">
              <Repeat2 aria-hidden="true" />
              Recurring
            </span>
          </p>
        </div>
      </header>
      <div className={s.stats}>
        <div>
          <strong>
            <Count value={summary.present} />
            <small>/{capacity}</small>
          </strong>
          <span>Present</span>
        </div>
        <div>
          <strong>
            <Count value={summary.absent} />
          </strong>
          <span>Absent</span>
        </div>
        <div>
          <strong>
            <Count value={summary.unmarked} />
          </strong>
          <span>Unmarked</span>
        </div>
      </div>
      <div className={s.classBody}>
        <div className={s.rosterPanel}>
          <div className={s.rosterHead}>
            <p>
              <strong>Attendance</strong>
              <span>Select a student to cycle attendance status.</span>
            </p>
            <span className={s.rosterIn}>
              {summary.present}/{capacity} in
            </span>
          </div>
          <ul className={s.roster} aria-label={`${studio.session.name} roster`}>
            {STUDENTS.map((student) => {
              const mark = state.marks[student.id] ?? "unmarked";
              const progress = studentProgress(student, mark);
              const ready = progress.standing === "ready";
              return (
                <li
                  key={student.id}
                  className={s.row}
                  data-mark={mark}
                  data-ready={ready}
                  data-selected={selected === student.id}
                  data-student={student.id}
                >
                  <button
                    type="button"
                    className={s.rowToggle}
                    ref={(node) => {
                      if (node) rowRefs.current.set(student.id, node);
                      else rowRefs.current.delete(student.id);
                    }}
                    onClick={() => onCycle(student.id)}
                    onFocus={() => onFocusStudent(student.id)}
                  >
                    <span className={s.avatar} aria-hidden="true">
                      {mark === "unmarked" ? (
                        initials(student.name)
                      ) : (
                        <span key={mark} className={s.pop}>
                          <MarkIcon mark={mark === "late" ? "present" : mark} />
                        </span>
                      )}
                    </span>
                    <span className={s.who}>
                      <span className={s.name}>
                        {student.name}
                        {ready ? (
                          <span className={s.readyBadge}>
                            <Check aria-hidden="true" />
                            Ready to test
                          </span>
                        ) : null}
                      </span>
                      <span className={s.reqLine}>
                        <span className={s.belt} data-belt={student.belt} aria-hidden="true" />
                        <span className={s.reqText}>
                          {BELT_LABELS[student.belt]}
                          <span className="sr-only">, classes toward next rank:</span>
                        </span>
                        <Bar
                          current={progress.classes}
                          required={student.required}
                          label={`${student.name} classes toward ${BELT_LABELS[student.nextBelt]}`}
                        />
                      </span>
                    </span>
                    <span className={s.status}>
                      <span className="sr-only">Attendance: </span>
                      {mark === "unmarked" ? (
                        MARK_LABELS.unmarked
                      ) : (
                        <span key={mark} className={s.pop}>
                          <MarkIcon mark={mark} />
                          {MARK_LABELS[mark]}
                        </span>
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={s.rowMore}
                    aria-label={`Open ${student.name}'s card`}
                    onClick={(event) => onOpenCard(student.id, event.currentTarget)}
                  >
                    <ChevronRight aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <aside className={s.quick} aria-label="Quick view">
          <p className={s.quickLabel}>Quick view</p>
          <StudentCard
            key={quickStudent.id}
            student={quickStudent}
            mark={state.marks[quickStudent.id] ?? "unmarked"}
            titleId="try-quick-title"
            titleRef={quickTitleRef}
          />
        </aside>
      </div>
    </div>
  );
}

function BeltsView({
  state,
  onOpenCard,
}: {
  state: TryState;
  onOpenCard: (id: string, opener: HTMLElement) => void;
}) {
  const register = beltRegister(STUDENTS, state.marks);
  const groups = BELT_ORDER.map((belt) => ({
    belt,
    students: STUDENTS.filter((student) => student.belt === belt),
  })).filter((group) => group.students.length > 0);
  return (
    <div className={s.page}>
      <header className={s.pageHead}>
        <h3 className={s.pageTitle}>Belt Tracker</h3>
      </header>
      <div className={s.controls}>
        <div className={s.segmented} aria-hidden="true">
          <span data-active="true">Eligibility</span>
          <span>Rank Plan</span>
        </div>
        <p className={s.programPick}>
          <span>Program</span>
          <strong>{studio.programs[0]}</strong>
        </p>
      </div>
      <div className={s.register} aria-label="Promotion decision summary">
        <div data-readiness="ready">
          <span>Ready</span>
          <strong>
            <Count value={register.ready} />
          </strong>
        </div>
        <div data-readiness="approval">
          <span>Approval</span>
          <strong>
            <Count value={register.approval} />
          </strong>
        </div>
        <div data-readiness="progress">
          <span>Progress</span>
          <strong>
            <Count value={register.progress} />
          </strong>
        </div>
      </div>
      <div className={s.tableFrame}>
        <table className={s.table}>
          <caption className="sr-only">Promotion readiness grouped by current rank</caption>
          <thead>
            <tr>
              <th scope="col">Student</th>
              <th scope="col">Next rank</th>
              <th scope="col">Classes</th>
              <th scope="col" data-optional="true">
                Time at rank
              </th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.belt}>
              <tr className={s.groupRow}>
                <th scope="rowgroup" colSpan={5}>
                  <RankBadge belt={group.belt} />
                  <span>
                    {group.students.length} student{group.students.length === 1 ? "" : "s"}
                  </span>
                </th>
              </tr>
              {group.students.map((student) => {
                const progress = studentProgress(student, state.marks[student.id] ?? "unmarked");
                return (
                  <tr key={student.id} data-readiness={progress.standing}>
                    <th scope="row">
                      <button
                        type="button"
                        className={s.linkish}
                        onClick={(event) => onOpenCard(student.id, event.currentTarget)}
                      >
                        {student.name}
                      </button>
                    </th>
                    <td>
                      <RankBadge belt={student.nextBelt} />
                    </td>
                    <td>
                      <Bar current={progress.classes} required={student.required} label="Classes" />
                    </td>
                    <td data-optional="true">
                      <Bar
                        current={student.daysAtRank}
                        required={student.daysRequired}
                        label="Days at rank"
                        unit=" days"
                      />
                    </td>
                    <td>
                      <span className={s.standing} data-standing={progress.standing}>
                        {progress.standing === "ready" ? (
                          <>
                            <Check aria-hidden="true" />
                            Ready to test
                          </>
                        ) : progress.standing === "approval" ? (
                          "Needs approval"
                        ) : (
                          <>
                            <Clock aria-hidden="true" />
                            In progress
                          </>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
    </div>
  );
}

function LeadsView({
  state,
  onAdd,
  onMove,
}: {
  state: TryState;
  onAdd: (opener: HTMLElement) => void;
  onMove: (id: string, direction: -1 | 1) => void;
}) {
  const totals = leadTotals(state.leads);
  const stages = stageCounts(state.leads);
  return (
    <div className={s.page}>
      <header className={s.pageHead}>
        <div>
          <h3 className={s.pageTitle}>Leads</h3>
          <p className={s.pageSub}>
            {totals.active} active · {totals.enrolled} enrolled
          </p>
        </div>
        <button type="button" className={s.primary} onClick={(event) => onAdd(event.currentTarget)}>
          <UserPlus aria-hidden="true" />
          Add lead
        </button>
      </header>
      <dl className={s.totals}>
        <div>
          <dt>Overdue</dt>
          <dd>
            <Count value={totals.overdue} />
          </dd>
        </div>
        <div>
          <dt>Due today</dt>
          <dd>
            <Count value={totals.dueToday} />
          </dd>
        </div>
        <div>
          <dt>Unassigned</dt>
          <dd>
            <Count value={totals.unassigned} />
          </dd>
        </div>
      </dl>
      <ol className={s.stageRail} aria-label="Lead stages">
        {STAGES.map((stage) => (
          <li key={stage.id}>
            <span>{stage.label}</span>
            <b>
              <Count value={stages[stage.id]} />
            </b>
          </li>
        ))}
      </ol>
      <div className={s.queue} aria-label="Lead next-action queue">
        {LEAD_BANDS.map((band) => {
          const leads = state.leads.filter((lead) => leadBand(lead) === band.id);
          if (leads.length === 0) return null;
          return (
            <section key={band.id} className={s.band} data-band={band.id}>
              <header>
                <h4>{band.label}</h4>
                <span>{leads.length}</span>
              </header>
              <ol>
                {leads.map((lead) => {
                  const index = STAGES.findIndex((stage) => stage.id === lead.stage);
                  return (
                    <li
                      key={lead.id}
                      className={s.lead}
                      data-touched={state.touchedLead === lead.id}
                    >
                      <div className={s.leadWho}>
                        <strong>{lead.name}</strong>
                        <span>
                          {STAGES[index]?.label} · {lead.program}
                        </span>
                      </div>
                      <div className={s.leadNext}>
                        <strong>{nextAction(lead.stage)}</strong>
                        <span>{followUpLabel(lead)}</span>
                      </div>
                      <div className={s.leadOwner}>
                        <span>{lead.owner ?? "Unassigned"}</span>
                        <small>
                          {SOURCE_LABELS[lead.source]}
                          {lead.minor ? " · Minor" : ""}
                        </small>
                      </div>
                      <div className={s.moves}>
                        <button
                          type="button"
                          aria-label={`Move ${lead.name} to the previous stage`}
                          disabled={index <= 0}
                          onClick={() => onMove(lead.id, -1)}
                        >
                          <ChevronLeft aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${lead.name} to the next stage`}
                          disabled={index >= STAGES.length - 1}
                          onClick={() => onMove(lead.id, 1)}
                        >
                          <ChevronRight aria-hidden="true" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Sheets */

function LeadForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (data: FormData) => void;
  onCancel: () => void;
}) {
  const { newLead } = studio;
  const [first, ...rest] = newLead.name.split(" ");
  return (
    <form className={s.form} action={onSubmit}>
      <div className={s.formPair}>
        <label>
          <span>First name</span>
          <input name="first" defaultValue={first} autoComplete="off" required maxLength={20} />
        </label>
        <label>
          <span>Last name</span>
          <input name="last" defaultValue={rest.join(" ")} autoComplete="off" maxLength={20} />
        </label>
      </div>
      <div className={s.formPair}>
        <label>
          <span>Source</span>
          <select name="source" defaultValue={newLead.source}>
            {Object.entries(SOURCE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Program</span>
          <select name="program" defaultValue={newLead.program}>
            {studio.programs.map((program) => (
              <option key={program}>{program}</option>
            ))}
          </select>
        </label>
      </div>
      <label>
        <span>Follow-up date</span>
        <select name="due" defaultValue={String(newLead.dueIn)}>
          <option value="0">Today ({weekday(0)})</option>
          <option value="1">Tomorrow ({weekday(1)})</option>
          <option value="3">{weekday(3)}</option>
        </select>
      </label>
      <div className={s.formActions}>
        <button type="button" className={s.secondary} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className={s.primary}>
          <UserPlus aria-hidden="true" />
          Add lead
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ The miniature */

export function TryIt() {
  const [state, setState] = useState<TryState>(() => initialTryState(STUDENTS, LEADS));
  const [view, setView] = useState<View>("class");
  const [selected, setSelected] = useState<string>(studio.ready.student);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [announcement, setAnnouncement] = useState("");
  const windowRef = useRef<HTMLDivElement>(null);
  const quickTitleRef = useRef<HTMLHeadingElement>(null);
  const sheetCloseRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const toastKey = useRef(0);
  const ids = useId();
  const done = tasksDone(state, STUDENTS);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (sheet) sheetCloseRef.current?.focus({ preventScroll: true });
  }, [sheet]);

  function act(action: TryAction) {
    const next = reducer(state, action);
    if (next === state) return next;
    setState(next);
    setAnnouncement(describeChange(state, next, action, STUDENTS));
    const readyBefore = beltRegister(STUDENTS, state.marks).ready;
    const readyAfter = beltRegister(STUDENTS, next.marks).ready;
    if (action.type === "cycle" && readyAfter > readyBefore) {
      const student = STUDENTS.find((candidate) => candidate.id === action.id);
      if (student) {
        toastKey.current += 1;
        setToast({
          key: toastKey.current,
          kind: "ready",
          text: `${student.name} is ready to test.`,
        });
      }
    } else if (action.type === "addLead") {
      const lead = next.leads.at(-1)!;
      toastKey.current += 1;
      setToast({
        key: toastKey.current,
        kind: "lead",
        text: `${lead.name} added · ${followUpLabel(lead)}`,
      });
    } else if (action.type === "reset" || (toast?.kind === "ready" && readyAfter < readyBefore)) {
      setToast(null);
    }
    return next;
  }

  function isWide() {
    return (windowRef.current?.offsetWidth ?? 0) >= 900;
  }

  function closeSheet() {
    setSheet(null);
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }

  function openCard(id: string, opener: HTMLElement) {
    setSelected(id);
    if (view === "class" && isWide()) {
      window.requestAnimationFrame(() => quickTitleRef.current?.focus({ preventScroll: true }));
      return;
    }
    openerRef.current = opener;
    setSheet({ kind: "card", id });
  }

  function openLeadForm(opener: HTMLElement) {
    openerRef.current = opener;
    setSheet({ kind: "lead" });
  }

  function submitLead(data: FormData) {
    const name = `${String(data.get("first") ?? "")} ${String(data.get("last") ?? "")}`;
    act({
      type: "addLead",
      lead: {
        name,
        program: String(data.get("program") ?? studio.programs[0]),
        source: String(data.get("source") ?? "walk_in") as DemoLeadSource,
        dueIn: Number(data.get("due") ?? 1),
      },
    });
    closeSheet();
  }

  function goToTask(task: TaskId, opener: HTMLElement) {
    if (task === "lead") {
      setView("leads");
      openLeadForm(opener);
      return;
    }
    setView("class");
    const target = task === "ready" ? studio.ready.student : STUDENTS[0].id;
    setSelected(target);
    window.requestAnimationFrame(() => rowRefs.current.get(target)?.focus({ preventScroll: true }));
  }

  function onSheetKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeSheet();
    }
  }

  function reset() {
    act({ type: "reset" });
    setView("class");
    setSelected(studio.ready.student);
    setSheet(null);
  }

  const sheetStudent =
    sheet?.kind === "card" ? STUDENTS.find((student) => student.id === sheet.id) : undefined;
  const register = beltRegister(STUDENTS, state.marks);
  const overdue = leadTotals(state.leads).overdue;

  return (
    <section id={studio.id} className={s.studio} aria-labelledby="studio-title">
      <div className={s.head}>
        <div className={s.intro}>
          <h2 id="studio-title" className={s.title}>
            {studio.title}
          </h2>
          <p className={s.lede}>{studio.lede}</p>
        </div>
        <ol className={s.tasks} aria-label="Things to try">
          {studio.tasks.map((task, index) => (
            <li key={task.id} data-done={done[task.id]}>
              <button
                type="button"
                className={s.task}
                onClick={(event) => goToTask(task.id, event.currentTarget)}
              >
                <span className={s.taskMark} aria-hidden="true">
                  <span>{index + 1}</span>
                  <Check />
                </span>
                <span className={s.taskText}>
                  <strong>{task.label}</strong>
                  <span>{task.detail}</span>
                </span>
                <span className="sr-only">{done[task.id] ? " (done)" : ""}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>

      <figure className={s.figure}>
        <div className={s.frame}>
          <div ref={windowRef} className={s.window} data-view={view}>
            <div className={s.shell}>
              <nav className={s.side} aria-label="Demo navigation">
                <p className={s.wordmark} aria-hidden="true">
                  Koaryu
                </p>
                <span className={s.me} aria-hidden="true">
                  R
                </span>
                <ul className={s.nav}>
                  {VIEWS.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        aria-current={view === item.id ? "page" : undefined}
                        onClick={() => {
                          setView(item.id);
                          setSheet(null);
                        }}
                      >
                        <span className={s.navIcon}>{item.icon}</span>
                        <span>{item.label}</span>
                        {item.id === "belts" && register.ready > 0 ? (
                          <span className={s.navBadge} data-tone="ready">
                            {register.ready}
                            <span className="sr-only"> ready</span>
                          </span>
                        ) : null}
                        {item.id === "leads" && overdue > 0 ? (
                          <span className={s.navBadge}>
                            {overdue}
                            <span className="sr-only"> overdue</span>
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
                <div className={s.user} aria-hidden="true">
                  <span>R</span>
                  <p>
                    {studio.studioName}
                    <small>Admin</small>
                  </p>
                </div>
              </nav>
              <div className={s.main}>
                <p className={s.crumbs}>
                  <span>{studio.studioName}</span>
                  <span aria-hidden="true">•</span>
                  <span>Admin</span>
                  <span className={s.sample}>Sample data</span>
                </p>
                {toast ? (
                  <div key={toast.key} className={s.toast} data-kind={toast.kind}>
                    <span className={s.toastIcon} aria-hidden="true">
                      {toast.kind === "ready" ? <MartialArtsBelt /> : <UserPlus />}
                    </span>
                    <p>{toast.text}</p>
                    {toast.kind === "ready" && view !== "belts" ? (
                      <button
                        type="button"
                        onClick={() => {
                          setView("belts");
                          setToast(null);
                        }}
                      >
                        Belt Tracker
                        <ChevronRight aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <div key={view} className={s.viewport}>
                  {view === "class" ? (
                    <ClassView
                      state={state}
                      selected={selected}
                      onCycle={(id) => {
                        setSelected(id);
                        act({ type: "cycle", id });
                      }}
                      onFocusStudent={setSelected}
                      onOpenCard={openCard}
                      quickTitleRef={quickTitleRef}
                      rowRefs={rowRefs}
                    />
                  ) : view === "belts" ? (
                    <BeltsView state={state} onOpenCard={openCard} />
                  ) : (
                    <LeadsView
                      state={state}
                      onAdd={openLeadForm}
                      onMove={(id, direction) => act({ type: "moveLead", id, direction })}
                    />
                  )}
                </div>
              </div>
            </div>

            {sheet ? <div className={s.scrim} onClick={closeSheet} aria-hidden="true" /> : null}
            {sheet ? (
              <div
                className={s.sheet}
                data-kind={sheet.kind}
                role="dialog"
                aria-labelledby={`${ids}-sheet`}
                onKeyDown={onSheetKey}
              >
                <div className={s.sheetHead}>
                  <p id={`${ids}-sheet`}>
                    {sheet.kind === "lead"
                      ? "Add lead"
                      : `${sheetStudent?.name ?? "Student"}'s card`}
                  </p>
                  <button
                    ref={sheetCloseRef}
                    type="button"
                    className={s.close}
                    aria-label="Close"
                    onClick={closeSheet}
                  >
                    <X aria-hidden="true" />
                  </button>
                </div>
                {sheet.kind === "lead" ? (
                  <LeadForm onSubmit={submitLead} onCancel={closeSheet} />
                ) : sheetStudent ? (
                  <StudentCard
                    student={sheetStudent}
                    mark={state.marks[sheetStudent.id] ?? "unmarked"}
                    titleId={`${ids}-card`}
                  />
                ) : null}
              </div>
            ) : null}

            <p className="sr-only" role="status" aria-live="polite">
              {announcement}
            </p>
          </div>
        </div>
        <figcaption className={s.caption}>
          <span>{studio.caption}</span>
          <button type="button" className={s.reset} onClick={reset}>
            <RotateCcw aria-hidden="true" />
            Reset demo
          </button>
        </figcaption>
      </figure>
    </section>
  );
}
