import { Logo } from "@/components/logo";
import { APP_TAGLINE } from "@/lib/constants";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 bg-bg">
      {/* Subtle top gradient line */}
      <div className="fixed top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-accent/30 to-transparent" />

      <div className="w-full max-w-[380px] flex flex-col items-center">
        {/* Logo and tagline */}
        <div className="mb-8 text-center">
          <div className="flex justify-center mb-3">
            <Logo size="lg" />
          </div>
          <p className="text-sm text-muted">{APP_TAGLINE}</p>
        </div>

        {/* Auth card */}
        <div className="w-full bg-surface border border-border rounded-[6px] p-6">
          {children}
        </div>
      </div>
    </div>
  );
}
