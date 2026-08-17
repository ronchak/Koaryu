import { BackendWarmup } from "@/components/backend-warmup";
import { JourneyChapters } from "@/components/marketing/journey/journey-chapters";
import { JourneyController } from "@/components/marketing/journey/journey-controller";
import { MarketingRoot } from "@/components/marketing/marketing-root";

export function LandingPage() {
  return (
    <MarketingRoot layout="document">
      <BackendWarmup />
      <JourneyController>
        <JourneyChapters />
      </JourneyController>
    </MarketingRoot>
  );
}
