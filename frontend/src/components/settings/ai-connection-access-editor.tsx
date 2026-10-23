"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { connectionStatus, type AiConnection } from "@/lib/mcp-connections";

export function AiConnectionAccessEditor({
  connection,
  permissions,
  busy,
  onSave,
  onCancel,
}: {
  connection: AiConnection;
  permissions: Record<string, string>;
  busy: boolean;
  onSave: (selected: string[], renewDays: number | null) => void;
  onCancel: () => void;
}) {
  const expired = connectionStatus(connection) === "Expired";
  const [selected, setSelected] = useState(() =>
    connection.permissions.filter((permission) => permission in permissions),
  );
  const [days, setDays] = useState(expired ? 7 : 0);

  return (
    <form
      className="mt-4 space-y-4 rounded-lg border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (selected.length > 0 && !busy) onSave(selected, days === 0 ? null : days);
      }}
    >
      <p className="font-medium [overflow-wrap:anywhere]">
        Change access for <bdi>{connection.client_name}</bdi>
      </p>
      <fieldset disabled={busy} className="space-y-3">
        <legend className="mb-3 text-sm">Information this assistant may read</legend>
        {Object.entries(permissions).map(([key, label]) => (
          <label key={key} className="flex items-start gap-3 text-sm">
            <input
              className="mt-1"
              type="checkbox"
              checked={selected.includes(key)}
              onChange={(event) =>
                setSelected((previous) =>
                  event.target.checked ? [...previous, key] : previous.filter((p) => p !== key),
                )
              }
            />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      <label className="block text-sm">
        Access expiration
        <select
          className="mt-2 block w-full rounded border border-border bg-surface-raised p-2"
          value={days}
          disabled={busy}
          onChange={(event) => setDays(Number(event.target.value))}
        >
          {!expired && <option value={0}>Keep current expiration</option>}
          <option value={7}>Renew for 7 days</option>
          <option value={30}>Renew for 30 days</option>
          <option value={90}>Renew for 90 days</option>
        </select>
      </label>
      <p className="text-sm text-text-secondary">
        Changes apply to future reads immediately. Information already received stays with your
        assistant.{" "}
        {days === 0
          ? "Your current expiration will stay the same."
          : `Access will expire ${days} days after you save.`}
      </p>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={busy || selected.length === 0} isLoading={busy}>
          {days === 0 ? "Save permissions" : "Save and renew access"}
        </Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
