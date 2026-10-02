import { BackendWarmup } from "@/components/backend-warmup";
import { JourneyChapters } from "@/components/marketing/journey/journey-chapters";
import { JourneyController } from "@/components/marketing/journey/journey-controller";
import journeyStyles from "@/components/marketing/journey/journey.module.css";
import { MarketingRoot } from "@/components/marketing/marketing-root";

export function LandingPage() {
  return (
    <MarketingRoot layout="document" className={journeyStyles.landingRoot}>
      <BackendWarmup />
      <JourneyController>
        <JourneyChapters />
      </JourneyController>
    </MarketingRoot>
  );
}
