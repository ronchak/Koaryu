"use client";

import { useState } from "react";
import { Header } from "@/components/header";
import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import { Save, Check } from "lucide-react";

export default function SettingsPage() {
  const store = useStore();
  const [name, setName] = useState(store.studioName);
  const [saved, setSaved] = useState(false);

  function handleSave() {
    store.setStudioName(name.trim() || "My Studio");
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <>
      <Header title="Settings" description="Studio configuration and preferences." />
      <div className="flex-1 p-8">
        <div className="max-w-xl space-y-6">
          {/* Studio info */}
          <section className="bg-surface border border-border rounded-[6px] p-5">
            <h3 className="text-sm font-medium text-text-primary mb-4">Studio Information</h3>
            <div className="space-y-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-text-secondary font-medium">Studio Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Studio"
                  className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none"
                />
              </div>
              <div className="flex items-center gap-2">
                <Button variant="primary" size="sm" onClick={handleSave}>
                  {saved ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
                  {saved ? "Saved" : "Save"}
                </Button>
                {saved && <span className="text-xs text-success">Settings updated</span>}
              </div>
            </div>
          </section>

          {/* Staff section */}
          <section className="bg-surface border border-border rounded-[6px] p-5">
            <h3 className="text-sm font-medium text-text-primary mb-1">Staff & Roles</h3>
            <p className="text-xs text-muted">
              Invite instructors and front-desk staff with role-based permissions. Available after connecting Supabase.
            </p>
          </section>

          {/* Data section */}
          <section className="bg-surface border border-border rounded-[6px] p-5">
            <h3 className="text-sm font-medium text-text-primary mb-1">Data Management</h3>
            <p className="text-xs text-muted mb-3">
              Your data is currently stored in your browser&apos;s local storage. It will persist between sessions but is not backed up.
            </p>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                if (confirm("This will clear ALL local data and reset to sample data. Continue?")) {
                  Object.keys(localStorage).forEach(key => {
                    if (key.startsWith("koaryu:")) localStorage.removeItem(key);
                  });
                  window.location.reload();
                }
              }}
            >
              Reset all data
            </Button>
          </section>
        </div>
      </div>
    </>
  );
}
