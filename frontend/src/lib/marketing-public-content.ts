export interface MarketingNextStep {
  eyebrow: string;
  title: string;
  description: string;
  href: string;
  action: string;
}

export const marketingNextStepsDefaults = {
  title: "Where to go next",
  description: "Choose the next page based on what you want to understand before trying Koaryu.",
};

export const marketingHeroDefaults = {
  ctaHref: "/signup",
  secondaryCta: { label: "Explore features", href: "/features" },
};

export const marketingDetailPageDefaults = {
  detailEyebrow: "What this solves",
  detailHeading: "Built for the decisions a studio owner actually makes.",
  detailDescription:
    "Each section explains when the workflow matters, what changes in daily operations, and how it connects to the rest of Koaryu.",
  relatedEyebrow: "Related workflows",
  relatedHeading: "Keep exploring the operating system",
  relatedActionLabel: "View all",
};

export const marketingDetailNextStepsDefaults = {
  title: "Choose the next useful page",
  description: "If this page made sense, the next step is either a related workflow, the broader product map, or a real setup.",
};

export const marketingIndexDefaults = {
  listHeading: "Workflows owners can recognize",
  listDescription:
    "Each one is specific, internally linked, and grounded in the daily operating decisions an independent studio owner actually makes.",
};

const sharedPublicNextSteps: MarketingNextStep[] = [
  {
    eyebrow: "Product",
    title: "Compare the main features",
    description: "See the product areas Koaryu already explains clearly: roster, belts, attendance, and billing visibility.",
    href: "/features",
    action: "Open features",
  },
  {
    eyebrow: "Workflows",
    title: "Start from a real studio problem",
    description: "Browse use cases for spreadsheets, retention, trial follow-up, tuition cleanup, and belt test readiness.",
    href: "/use-cases",
    action: "Open use cases",
  },
  {
    eyebrow: "Setup",
    title: "Try Koaryu with your studio",
    description: "Start setup when you are ready to see the product against a real roster and real operating work.",
    href: "/signup",
    action: "Start setup",
  },
];

export const indexNextSteps: MarketingNextStep[] = [
  {
    eyebrow: "Directory",
    title: "Use the Explore guide",
    description: "Find the right product, workflow, or studio-fit page without guessing where to start.",
    href: "/explore",
    action: "Open Explore",
  },
  ...sharedPublicNextSteps.slice(1),
];

export const detailNextSteps = sharedPublicNextSteps;

export function nextStepsForIndex(basePath: "/features" | "/use-cases"): MarketingNextStep[] {
  if (basePath === "/use-cases") {
    return [
      indexNextSteps[0],
      sharedPublicNextSteps[0],
      sharedPublicNextSteps[2],
    ];
  }

  return indexNextSteps;
}
