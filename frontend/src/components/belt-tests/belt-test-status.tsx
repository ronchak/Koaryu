import { ToneTag, type HorizonTone } from "@/components/ui/horizon";
import type { ApiBeltTestEventResponse as Event } from "@/types/generated/api-contracts";
import styles from "./belt-tests.module.css";

const STATUS: Record<Event["status"], { label: string; tone: HorizonTone }> = {
  draft: { label: "Draft", tone: "warn" },
  scheduled: { label: "Scheduled", tone: "calm" },
  completed: { label: "Completed", tone: "neutral" },
  canceled: { label: "Canceled", tone: "neutral" },
};

/** The event's state in words; drafts still need scheduling, so they carry the warn tone. */
export function BeltTestStatusTag({ status }: { status: Event["status"] }) {
  const { label, tone } = STATUS[status] ?? { label: status, tone: "neutral" as const };
  return (
    <ToneTag tone={tone} dot={tone !== "neutral"}>
      {label}
    </ToneTag>
  );
}

type EventTime = Pick<Event, "starts_at" | "ends_at" | "timezone">;

function parts(event: EventTime) {
  try {
    const zone = event.timezone || undefined;
    const start = new Date(event.starts_at);
    const end = new Date(event.ends_at);
    if (Number.isNaN(start.valueOf())) return null;
    const day = new Intl.DateTimeFormat("en", { timeZone: zone, day: "numeric" }).format(start);
    const month = new Intl.DateTimeFormat("en", { timeZone: zone, month: "short" }).format(start);
    const date = new Intl.DateTimeFormat("en", {
      timeZone: zone,
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(start);
    const time = new Intl.DateTimeFormat("en", {
      timeZone: zone,
      hour: "numeric",
      minute: "2-digit",
    });
    const range = Number.isNaN(end.valueOf())
      ? time.format(start)
      : `${time.format(start)} – ${time.format(end)}`;
    return { date, day, month, range };
  } catch {
    return null;
  }
}

/** A calendar leaf for the event's start, in the event's own timezone. */
export function BeltTestDateLeaf({ event }: { event: EventTime }) {
  const when = parts(event);
  return (
    <span className={styles.dateLeaf} aria-hidden="true">
      <span>{when?.month ?? "—"}</span>
      <strong>{when?.day ?? ""}</strong>
    </span>
  );
}

/** "Sat, Oct 17, 2026 · 10:00 AM – 12:00 PM" in the event's timezone. */
export function beltTestWhen(event: EventTime) {
  const when = parts(event);
  return when ? `${when.date} · ${when.range}` : event.starts_at;
}
