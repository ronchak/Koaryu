import Link from "next/link";
import { notFound } from "next/navigation";
import { Header } from "@/components/header";
import { HorizonPage } from "@/components/ui/horizon";
import { BeltTestWorkspace } from "@/components/belt-tests/belt-test-workspace";
import { isBeltTestTarget } from "@/lib/belt-test-contract";
import styles from "@/components/belt-tests/belt-tests.module.css";

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
    <div className={styles.page}>
      <Header
        eyebrow="Belt Tracker"
        title="Belt tests"
        description="Schedule a test, approve the students who are ready for it, and keep the record."
      >
        <Link href="/belt-tracker" className={styles.headerLink}>
          Open Belt Tracker
        </Link>
      </Header>
      <HorizonPage>
        <BeltTestWorkspace requestedTarget={requestedTarget} />
      </HorizonPage>
    </div>
  );
}
