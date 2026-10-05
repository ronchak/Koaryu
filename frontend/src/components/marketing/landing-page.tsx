import { BackendWarmup } from "@/components/backend-warmup";
import { JourneyChapters } from "@/components/marketing/journey/journey-chapters";
import { JourneyController } from "@/components/marketing/journey/journey-controller";
import { SceneTimeScript } from "@/components/marketing/journey/scene-time-script";
import journeyStyles from "@/components/marketing/journey/journey.module.css";
import { MarketingRoot } from "@/components/marketing/marketing-root";

export function LandingPage() {
  return (
    <MarketingRoot layout="document" className={journeyStyles.landingRoot}>
      <SceneTimeScript />
      <BackendWarmup />
      <JourneyController>
        <JourneyChapters />
      </JourneyController>
    </MarketingRoot>
  );
}
