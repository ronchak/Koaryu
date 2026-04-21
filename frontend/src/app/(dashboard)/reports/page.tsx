import { Header } from "@/components/header";
import { BarChart3, ArrowRight } from "lucide-react";

export default function ReportsPage() {
  return (
    <>
      <Header title="Reports" description="Studio performance and operational metrics." />
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <div className="w-12 h-12 rounded-[12px] bg-success/10 flex items-center justify-center mx-auto mb-4">
            <BarChart3 className="w-6 h-6 text-success" />
          </div>
          <h2 className="text-base font-semibold text-text-primary mb-2">
            Reports coming soon
          </h2>
          <p className="text-sm text-text-secondary leading-relaxed mb-4">
            Track studio health with visual reports on attendance, retention, revenue, and growth. Reports will populate as you build your data history.
          </p>
          <div className="bg-surface border border-border rounded-[6px] p-4 text-left space-y-2">
            <p className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">Planned reports</p>
            {[
              "Student retention & churn analysis",
              "Class attendance trends",
              "Lead conversion funnel",
              "Revenue & growth metrics",
            ].map((f) => (
              <div key={f} className="flex items-center gap-2 text-xs text-muted">
                <ArrowRight className="w-3 h-3 text-success flex-shrink-0" />
                {f}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
