"use client";

import { Header } from "@/components/header";
import { useStore } from "@/lib/store";
import {
  Users,
  UserPlus,
  Calendar,
  Award,
  TrendingUp,
  Clock,
} from "lucide-react";
import Link from "next/link";

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  href,
  accent,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  sub?: string;
  href?: string;
  accent?: string;
}) {
  const content = (
    <div
      className={`bg-surface border border-border rounded-[6px] p-5 transition-colors ${
        href ? "hover:border-accent/40 cursor-pointer" : ""
      }`}
    >
      <div className="flex items-center gap-3 mb-3">
        <div
          className="w-8 h-8 rounded-[6px] flex items-center justify-center"
          style={{ backgroundColor: accent ? `${accent}15` : "var(--surface-raised)" }}
        >
          <Icon className="w-4 h-4" style={{ color: accent || "var(--text-secondary)" }} />
        </div>
        <span className="text-xs text-muted font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p className="text-2xl font-bold text-text-primary font-mono">{value}</p>
      {sub && <p className="text-xs text-muted mt-1">{sub}</p>}
    </div>
  );

  if (href) return <Link href={href}>{content}</Link>;
  return content;
}

export default function DashboardPage() {
  const store = useStore();

  const totalStudents = store.students.length;
  const activeStudents = store.students.filter(
    (s) => s.status === "active" || s.status === "trialing"
  ).length;
  const trialingStudents = store.students.filter(
    (s) => s.status === "trialing"
  ).length;

  const activeLeads = store.leads.filter(
    (l) => l.stage !== "closed_lost" && l.stage !== "enrolled"
  ).length;
  const enrolledLeads = store.leads.filter((l) => l.stage === "enrolled").length;

  const today = new Date().toISOString().split("T")[0];
  const todaySessions = store.sessions.filter((s) => s.date === today).length;

  const beltCount = store.beltRanks.filter(r => !r.is_tip).length;

  return (
    <>
      <Header
        title="Dashboard"
        description={store.studioName || "Your studio at a glance."}
      />
      <div className="flex-1 p-8">
        <div className="max-w-5xl">
          {/* Stat grid */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <StatCard
              icon={Users}
              label="Total Students"
              value={totalStudents}
              sub={`${activeStudents} active · ${trialingStudents} trialing`}
              href="/students"
              accent="#3B82F6"
            />
            <StatCard
              icon={UserPlus}
              label="Active Leads"
              value={activeLeads}
              sub={`${enrolledLeads} enrolled this period`}
              href="/leads"
              accent="#8B5CF6"
            />
            <StatCard
              icon={Calendar}
              label="Today's Classes"
              value={todaySessions}
              sub={todaySessions === 0 ? "No classes scheduled" : `${todaySessions} session${todaySessions > 1 ? "s" : ""} today`}
              href="/schedule"
              accent="#F59E0B"
            />
            <StatCard
              icon={Award}
              label="Belt Ranks"
              value={beltCount}
              sub={`${store.beltRanks.filter(r => r.is_tip).length} ${store.subRankTerm.toLowerCase()}s configured`}
              href="/belt-tracker"
              accent="#22C55E"
            />
          </div>

          {/* Quick actions */}
          <div className="bg-surface border border-border rounded-[6px] p-5">
            <h3 className="text-sm font-medium text-text-primary mb-4 flex items-center gap-2">
              <TrendingUp className="w-3.5 h-3.5 text-muted" />
              Quick Actions
            </h3>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {[
                { label: "Add Student", href: "/students", icon: Users },
                { label: "Import CSV", href: "/students/import", icon: Clock },
                { label: "View Schedule", href: "/schedule", icon: Calendar },
                { label: "Belt Tracker", href: "/belt-tracker", icon: Award },
              ].map((action) => (
                <Link
                  key={action.label}
                  href={action.href}
                  className="flex items-center gap-2.5 px-4 py-3 bg-surface-raised border border-border rounded-[6px] hover:border-accent/40 transition-colors text-sm text-text-secondary hover:text-text-primary"
                >
                  <action.icon className="w-3.5 h-3.5 text-muted" />
                  {action.label}
                </Link>
              ))}
            </div>
          </div>

          {/* Recent students */}
          {store.students.length > 0 && (
            <div className="bg-surface border border-border rounded-[6px] p-5 mt-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-medium text-text-primary">Recent Students</h3>
                <Link href="/students" className="text-xs text-accent hover:text-accent-hover">
                  View all →
                </Link>
              </div>
              <div className="space-y-2">
                {store.students.slice(0, 5).map((s) => (
                  <Link
                    key={s.id}
                    href={`/students/${s.id}`}
                    className="flex items-center justify-between px-3 py-2 rounded-[6px] hover:bg-surface-raised transition-colors"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="w-6 h-6 rounded-full bg-surface-raised border border-border flex items-center justify-center flex-shrink-0">
                        <span className="text-[10px] font-medium text-text-secondary">
                          {s.legal_first_name[0]}{s.legal_last_name[0]}
                        </span>
                      </div>
                      <span className="text-sm text-text-primary">
                        {s.preferred_name || s.legal_first_name} {s.legal_last_name}
                      </span>
                    </div>
                    <span className={`text-xs px-1.5 py-0.5 rounded-[4px] capitalize ${
                      s.status === "active" ? "text-success bg-success/10" :
                      s.status === "trialing" ? "text-accent bg-accent/10" :
                      "text-muted bg-surface-raised"
                    }`}>
                      {s.status}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
