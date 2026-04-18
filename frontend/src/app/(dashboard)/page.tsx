import { Header } from "@/components/header";

export default function DashboardPage() {
  return (
    <>
      <Header
        title="Dashboard"
        description="Your studio at a glance."
      />
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center">
          <p className="text-sm text-text-secondary mb-1">
            Welcome to Koaryu.
          </p>
          <p className="text-xs text-muted">
            Dashboard metrics will appear here once you add students and schedule classes.
          </p>
        </div>
      </div>
    </>
  );
}
