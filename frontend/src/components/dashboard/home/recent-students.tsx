import { UserPlus } from "lucide-react";
import {
  CalmState,
  HorizonPanel,
  HorizonPanelLink,
  HorizonWorkList,
  HorizonWorkRow,
} from "@/components/ui/horizon";
import { HOME_COPY, homeNewStudentMeta } from "@/lib/dashboard/home-copy";
import { HOME_LINKS, type HomeNewStudentRow } from "@/lib/dashboard/home-model";

/** "New students": the latest students added; each row opens the student (D4). Null rows: couldn't check. */
export function NewStudentsPanel({ rows }: { rows: readonly HomeNewStudentRow[] | null }) {
  const copy = HOME_COPY.newStudents;
  return (
    <HorizonPanel
      title={copy.title}
      titleId="home-new-students-title"
      actions={<HorizonPanelLink href={HOME_LINKS.students}>{copy.link}</HorizonPanelLink>}
    >
      {rows === null ? (
        <CalmState tone="neutral" title={copy.missing.title} />
      ) : rows.length === 0 ? (
        <CalmState
          tone="neutral"
          icon={<UserPlus aria-hidden="true" />}
          title={copy.empty.title}
          detail={copy.empty.detail}
        />
      ) : (
        <HorizonWorkList>
          {rows.map((row) => (
            <HorizonWorkRow
              key={row.id}
              data-home-row={row.id}
              href={row.href}
              title={row.name}
              meta={homeNewStudentMeta(row) ?? undefined}
            />
          ))}
        </HorizonWorkList>
      )}
    </HorizonPanel>
  );
}
