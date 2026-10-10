import Link from "next/link";
import { Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  HorizonScene,
  SceneSheet,
  SceneSolo,
  sceneSheetLedeClassName,
  sceneSheetTitleClassName,
} from "@/components/auth/horizon-scene";
import { ToneChip } from "@/components/settings/horizon-parts";

export default function AccessDeniedPage() {
  return (
    <HorizonScene homeHref="/dashboard">
      <SceneSolo>
        <SceneSheet labelledBy="access-denied-title">
          <ToneChip tone="warn">
            <Lock />
          </ToneChip>
          <p className="mt-5 text-xs font-bold uppercase tracking-[0.16em] text-muted">
            Access denied
          </p>
          <h1 id="access-denied-title" className={`mt-2 ${sceneSheetTitleClassName}`}>
            This area is not available for your role
          </h1>
          <p className={sceneSheetLedeClassName}>
            No protected billing information was loaded. Contact a studio admin if you need help.
          </p>
          <Button asChild variant="primary" size="lg" className="mt-6 w-full">
            <Link href="/dashboard">Return to dashboard</Link>
          </Button>
        </SceneSheet>
      </SceneSolo>
    </HorizonScene>
  );
}
