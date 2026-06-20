"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { getMobileNavPanelState } from "@/lib/mobile-nav-state";
import { publicNavLinks, type PublicNavigationLink } from "@/lib/public-navigation";

export function MobileNav({
  links = publicNavLinks,
}: {
  links?: PublicNavigationLink[];
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelState = getMobileNavPanelState(open);

  const closeNav = () => {
    setOpen(false);
    window.requestAnimationFrame(() => {
      triggerRef.current?.focus();
    });
  };

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
        ref={triggerRef}
        onClick={() => setOpen(true)}
        className="md:hidden flex items-center justify-center w-9 h-9 text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
        aria-label="Open navigation"
        aria-expanded={open}
        aria-controls="mobile-public-navigation"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity duration-300 ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={closeNav}
        aria-hidden
      />

      {/* Slide-out panel */}
      <nav
        id="mobile-public-navigation"
        className={panelState.className}
        data-state={panelState.state}
        aria-hidden={panelState.ariaHidden}
        inert={panelState.inert}
      >
        {/* Panel header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <span className="text-sm font-medium text-text-secondary tracking-wide uppercase">
            Menu
          </span>
          <button
            onClick={closeNav}
            className="flex items-center justify-center w-8 h-8 text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
            aria-label="Close navigation"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Links */}
        <div className="flex flex-col px-6 py-6 gap-1">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={closeNav}
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
            onClick={closeNav}
            className="flex items-center justify-center w-full py-2.5 text-sm font-medium bg-accent text-accent-contrast hover:bg-accent-hover transition-colors"
            style={{ borderRadius: "6px" }}
          >
            Sign In
          </Link>
        </div>
      </nav>
    </>
  );
}
