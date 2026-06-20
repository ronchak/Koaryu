export type PublicNavigationLink = {
  href: string;
  label: string;
};

export const publicNavLinks: PublicNavigationLink[] = [
  { href: "/features", label: "Features" },
  { href: "/use-cases", label: "Use Cases" },
  { href: "/explore", label: "Explore" },
  { href: "/#pricing", label: "Pricing" },
  { href: "/about", label: "About" },
];

export const publicFooterLinks: PublicNavigationLink[] = [
  { href: "/explore", label: "Explore" },
  { href: "/features", label: "Features" },
  { href: "/use-cases", label: "Use Cases" },
  { href: "/about", label: "About" },
  { href: "/terms", label: "Terms of Service" },
  { href: "/privacy", label: "Privacy Policy" },
];
