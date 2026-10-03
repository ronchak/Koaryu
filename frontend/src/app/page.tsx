import type { Metadata } from "next";

import { LandingPage } from "@/components/marketing/landing-page";

export const metadata: Metadata = {
  // Public ownership proof for the Google OAuth project's owner account.
  verification: {
    google: "j6q1TFenzx7ICDlYvS2Zn0hR102FTwxBqK_yQGT7ohg",
  },
  alternates: {
    canonical: "https://koaryu.app/",
  },
};

export default LandingPage;
