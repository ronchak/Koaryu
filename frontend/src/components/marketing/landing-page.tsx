import { BackendWarmup } from "@/components/backend-warmup";
import { JourneyStory } from "@/components/marketing/journey/journey-chapters";
import { JourneyController } from "@/components/marketing/journey/journey-controller";
import { SceneTimeScript } from "@/components/marketing/journey/scene-time-script";
import journeyStyles from "@/components/marketing/journey/journey.module.css";
import { LandingPageSections } from "@/components/marketing/landing/page-sections";
import { MarketingRoot } from "@/components/marketing/marketing-root";

/**
 * Act one is a paged, illustrated story; the last page turn hands the picture
 * off into a framed still and act two reads as an ordinary product page.
 */
export function LandingPage() {
  return (
    <MarketingRoot layout="document" className={journeyStyles.landingRoot}>
      <SceneTimeScript />
      <BackendWarmup />
      <JourneyController>
        <main id="main-content" tabIndex={-1} className={journeyStyles.main}>
          <JourneyStory />
          <LandingPageSections />
        </main>
      </JourneyController>
    </MarketingRoot>
  );
}
