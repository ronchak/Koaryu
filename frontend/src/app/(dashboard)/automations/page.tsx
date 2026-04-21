import { Header } from "@/components/header";
import { Zap, ArrowRight } from "lucide-react";

export default function AutomationsPage() {
  return (
    <>
      <Header title="Automations" description="Rules-based email workflows." />
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <div className="w-12 h-12 rounded-[12px] bg-warning/10 flex items-center justify-center mx-auto mb-4">
            <Zap className="w-6 h-6 text-warning" />
          </div>
          <h2 className="text-base font-semibold text-text-primary mb-2">
            Automations coming soon
          </h2>
          <p className="text-sm text-text-secondary leading-relaxed mb-4">
            Set up automated workflows to save time on repetitive tasks. Trigger emails, status changes, and reminders based on rules you define.
          </p>
          <div className="bg-surface border border-border rounded-[6px] p-4 text-left space-y-2">
            <p className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">Planned features</p>
            {[
              "Follow-up reminders for new leads",
              "Membership expiry notifications",
              "Birthday and milestone emails",
              "Automatic status changes after inactivity",
            ].map((f) => (
              <div key={f} className="flex items-center gap-2 text-xs text-muted">
                <ArrowRight className="w-3 h-3 text-warning flex-shrink-0" />
                {f}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
