import { notFound } from "next/navigation";
import { Header } from "@/components/header";
import { BeltTestWorkspace } from "@/components/belt-tests/belt-test-workspace";
import { isBeltTestTarget } from "@/lib/belt-test-contract";
import styles from "@/components/belt-tracker/belt-tracker.module.css";

export default async function BeltTestsPage({
  searchParams,
}: {
  searchParams: Promise<{ draft?: string | string[]; event?: string | string[] }>;
}) {
  const { draft, event } = await searchParams;
  const target =
    draft !== undefined
      ? { kind: "draft", id: draft }
      : event !== undefined
        ? { kind: "event", id: event }
        : null;
  if (
    (draft !== undefined && event !== undefined) ||
    (target !== null && !isBeltTestTarget(target))
  )
    notFound();
  const requestedTarget =
    target && isBeltTestTarget(target) ? { ...target, id: target.id.toLowerCase() } : null;
  return (
    <div className={`flex min-h-full flex-col ${styles.beltPage}`}>
      <Header title="Belt tests" />
      <BeltTestWorkspace requestedTarget={requestedTarget} />
    </div>
  );
}
