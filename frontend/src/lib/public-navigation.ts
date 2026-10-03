export type PublicNavigationLink = {
  href: string;
  label: string;
};

export const publicNavLinks: PublicNavigationLink[] = [
  { href: "/features", label: "Features" },
  { href: "/use-cases", label: "Workflows" },
  { href: "/#pricing", label: "Pricing" },
];

export const publicFooterLinks: PublicNavigationLink[] = [
  { href: "/features", label: "Features" },
  { href: "/use-cases", label: "Workflows" },
  { href: "/terms", label: "Terms of Service" },
  { href: "/privacy", label: "Privacy Policy" },
];
