import { Header } from "@/components/header";

export default function SettingsPage() {
  return (
    <>
      <Header title="Settings" description="Studio configuration and preferences." />
      <div className="flex-1 p-8">
        <div className="max-w-xl space-y-6">
          {/* Studio info section */}
          <section className="bg-surface border border-border rounded-[6px] p-5">
            <h3 className="text-sm font-medium text-text-primary mb-1">Studio Information</h3>
            <p className="text-xs text-muted">
              Studio settings will be configurable here once your backend is connected.
            </p>
          </section>

          {/* Staff section */}
          <section className="bg-surface border border-border rounded-[6px] p-5">
            <h3 className="text-sm font-medium text-text-primary mb-1">Staff & Roles</h3>
            <p className="text-xs text-muted">
              Invite instructors and front-desk staff with role-based permissions.
            </p>
          </section>

          {/* Danger zone */}
          <section className="bg-surface border border-danger/20 rounded-[6px] p-5">
            <h3 className="text-sm font-medium text-danger mb-1">Danger Zone</h3>
            <p className="text-xs text-muted">
              Delete studio, export data, and account management.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}
