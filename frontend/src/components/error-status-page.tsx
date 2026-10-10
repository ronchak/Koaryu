import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  HorizonScene,
  SceneSheet,
  SceneSolo,
  sceneSheetLedeClassName,
  sceneSheetTitleClassName,
} from "@/components/auth/horizon-scene";
import { ToneChip, type HorizonTone } from "@/components/ui/horizon-parts";

type StatusTone = "missing" | "warning" | "danger" | "offline";

interface ErrorStatusPageProps {
  statusCode: string;
  eyebrow: string;
  title: string;
  description: string;
  icon: LucideIcon;
  tone?: StatusTone;
  actions?: ReactNode;
}

const horizonTone: Record<StatusTone, HorizonTone> = {
  missing: "neutral",
  warning: "warn",
  danger: "alert",
  offline: "neutral",
};

export function ErrorStatusPage({
  statusCode,
  eyebrow,
  title,
  description,
  icon: Icon,
  tone = "warning",
  actions,
}: ErrorStatusPageProps) {
  return (
    <main className="min-h-screen">
      <HorizonScene>
        <SceneSolo>
          <SceneSheet labelledBy="status-title" width="wide">
            <div className="flex items-center justify-between gap-4">
              <ToneChip tone={horizonTone[tone]}>
                <Icon aria-hidden="true" />
              </ToneChip>
              <span
                className="text-5xl font-extrabold leading-none tracking-[-0.05em] text-text-primary/15 tabular-nums sm:text-6xl"
                aria-hidden="true"
              >
                {statusCode}
              </span>
            </div>
            <p className="mt-5 text-xs font-bold uppercase tracking-[0.16em] text-muted">
              <span className="sr-only">Status {statusCode}: </span>
              {eyebrow}
            </p>
            <h1 id="status-title" className={`mt-2 ${sceneSheetTitleClassName}`}>
              {title}
            </h1>
            <p className={sceneSheetLedeClassName}>{description}</p>

            {actions && <div className="mt-6 flex flex-wrap items-center gap-3">{actions}</div>}
          </SceneSheet>
        </SceneSolo>
      </HorizonScene>
    </main>
  );
}
