"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";

const navLinks = [
  { href: "#product", label: "Product" },
  { href: "#pricing", label: "Pricing" },
  { href: "#privacy", label: "Privacy" },
  { href: "#faq", label: "FAQ" },
];

export function MobileNav() {
  const [open, setOpen] = useState(false);

  /* Lock body scroll when panel is open */
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <>
      {/* Hamburger trigger – visible only on mobile */}
      <button
        onClick={() => setOpen(true)}
        className="md:hidden flex items-center justify-center w-9 h-9 text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
        aria-label="Open navigation"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity duration-300 ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={() => setOpen(false)}
        aria-hidden
      />

      {/* Slide-out panel */}
      <nav
        className={`fixed top-0 right-0 z-50 h-full w-72 bg-surface border-l border-border flex flex-col transition-transform duration-300 ease-[cubic-bezier(0.25,0.46,0.45,0.94)] ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Panel header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <span className="text-sm font-medium text-text-secondary tracking-wide uppercase">
            Menu
          </span>
          <button
            onClick={() => setOpen(false)}
            className="flex items-center justify-center w-8 h-8 text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
            aria-label="Close navigation"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Links */}
        <div className="flex flex-col px-6 py-6 gap-1">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className="py-3 text-base text-text-secondary hover:text-text-primary transition-colors border-b border-border last:border-b-0"
            >
              {link.label}
            </Link>
          ))}
        </div>

        {/* Bottom CTA */}
        <div className="mt-auto px-6 py-6 border-t border-border">
          <Link
            href="/login"
            onClick={() => setOpen(false)}
            className="flex items-center justify-center w-full py-2.5 text-sm font-medium bg-accent text-[#0B0D10] hover:bg-accent-hover transition-colors"
            style={{ borderRadius: "6px" }}
          >
            Sign In
          </Link>
        </div>
      </nav>
    </>
  );
}
