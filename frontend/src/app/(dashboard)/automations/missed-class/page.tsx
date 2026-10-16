import { IntentPrefetchLink as Link } from "@/components/intent-prefetch-link";
import { ArrowLeft } from "lucide-react";
import { Header } from "@/components/header";
import { OperationsSurface } from "@/components/operations/operations-surface";
import { Button } from "@/components/ui/button";
import { HorizonPage } from "@/components/ui/horizon";
import { MissedClassAutomation } from "@/components/automations/missed-class-automation";
import { crmLinkPrefetch } from "@/lib/constants";
import styles from "../automations-page.module.css";

export default function MissedClassPage() {
  return (
    <OperationsSurface page="automations">
      <Header
        eyebrow="Automations"
        title="Missed-class nudges"
        description="A friendly check-in after time away from class. Each student gets one message per absence; a return to class starts a new period."
      >
        <Button asChild variant="secondary" size="lg">
          <Link href="/automations" prefetch={crmLinkPrefetch("/automations")}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            All automations
          </Link>
        </Button>
      </Header>
      <div className={styles.body} data-automation-detail="missed-class">
        <HorizonPage className={styles.page}>
          <MissedClassAutomation headless />
        </HorizonPage>
      </div>
    </OperationsSurface>
  );
}
