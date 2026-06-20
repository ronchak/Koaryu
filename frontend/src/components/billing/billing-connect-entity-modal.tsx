"use client";

import { useState, type ReactNode } from "react";
import { Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModalFrame } from "@/components/ui/modal-frame";
import type { ConnectBusinessEntityType } from "@/types";

function ConnectEntityModal({
  connectEntityType,
  isActionLoading,
  isConnectLoading,
  onCancel,
  onChangeEntityType,
  onConfirm,
}: {
  connectEntityType: ConnectBusinessEntityType;
  isActionLoading: boolean;
  isConnectLoading: boolean;
  onCancel: () => void;
  onChangeEntityType: (value: ConnectBusinessEntityType) => void;
  onConfirm: () => void;
}) {
  return (
    <ModalFrame
      rootClassName="p-4"
      panelClassName="w-full max-w-md rounded-[6px] border border-border bg-bg p-5 shadow-2xl"
      ariaLabelledBy="connect-entity-title"
      onBackdropClick={onCancel}
    >
      <h2 id="connect-entity-title" className="text-base font-semibold text-text-primary">Connect Stripe payments</h2>
      <p className="mt-2 text-sm text-muted">
        Choose the legal account type before Koaryu creates the Stripe account. If the studio is not registered yet, use the sole proprietor option. After the account is created, legal entity changes happen in Stripe or by reconnecting a new account before payment history exists.
      </p>
      <div className="mt-4 grid gap-2">
        {([
          ["individual", "Sole proprietor / individual", "Use this when the studio operates under an individual owner without a separate legal company."],
          ["company", "Registered business / company", "Use this for LLCs, corporations, partnerships, and incorporated studios with their own legal/tax details."],
        ] as const).map(([value, label, description]) => (
          <label
            key={value}
            className={`cursor-pointer rounded-[6px] border px-3 py-3 transition-colors ${
              connectEntityType === value
                ? "border-accent bg-accent/10"
                : "border-border bg-surface hover:bg-surface-hover"
            }`}
          >
            <span className="flex items-start gap-3">
              <input
                type="radio"
                name="connect-entity-type"
                value={value}
                checked={connectEntityType === value}
                onChange={() => onChangeEntityType(value)}
                className="mt-1 accent-[#E5C15C]"
              />
              <span>
                <span className="block text-sm font-medium text-text-primary">{label}</span>
                <span className="mt-1 block text-xs leading-5 text-muted">{description}</span>
              </span>
            </span>
          </label>
        ))}
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={isActionLoading} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" isLoading={isConnectLoading} disabled={isActionLoading} onClick={onConfirm}>
          <Link2 className="h-3.5 w-3.5" />
          {isConnectLoading ? "Opening Stripe..." : "Create Stripe account"}
        </Button>
      </div>
    </ModalFrame>
  );
}

export function useBillingConnectEntityModal({
  isActionLoading,
  isConnectLoading,
  onConfirmConnectEntity,
}: {
  isActionLoading: boolean;
  isConnectLoading: boolean;
  onConfirmConnectEntity: (businessEntityType: ConnectBusinessEntityType) => Promise<void>;
}): {
  connectEntityModal: ReactNode;
  openConnectEntityModal: () => void;
} {
  const [isOpen, setIsOpen] = useState(false);
  const [connectEntityType, setConnectEntityType] = useState<ConnectBusinessEntityType>("individual");

  async function handleConfirmConnectEntity() {
    setIsOpen(false);
    await onConfirmConnectEntity(connectEntityType);
  }

  return {
    connectEntityModal: isOpen ? (
      <ConnectEntityModal
        connectEntityType={connectEntityType}
        isActionLoading={isActionLoading}
        isConnectLoading={isConnectLoading}
        onCancel={() => setIsOpen(false)}
        onChangeEntityType={setConnectEntityType}
        onConfirm={() => void handleConfirmConnectEntity()}
      />
    ) : null,
    openConnectEntityModal: () => setIsOpen(true),
  };
}
