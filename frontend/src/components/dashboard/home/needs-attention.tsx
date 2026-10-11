import { Check, Clock3, CreditCard, ListChecks, Phone, type LucideIcon } from "lucide-react";
import {
  CalmState,
  HorizonPanel,
  HorizonWorkList,
  HorizonWorkRow,
  ToneChip,
} from "@/components/ui/horizon";
import { HOME_COPY, homeAttentionCopy } from "@/lib/dashboard/home-copy";
import type { HomeAttentionItem, HomeAttentionKind } from "@/lib/dashboard/home-model";

const ICONS: Record<HomeAttentionKind, LucideIcon> = {
  payments: CreditCard,
  setup: ListChecks,
  away: Clock3,
  contact: Phone,
};

/**
 * Band two: things that need a hand and have no list of their own on Home (D2).
 * `items` is null when the server couldn't compute them.
 */
export function NeedsAttention({ items }: { items: readonly HomeAttentionItem[] | null }) {
  const copy = HOME_COPY.attention;
  return (
    <HorizonPanel title={copy.title} titleId="home-attention-title">
      {items === null ? (
        <CalmState tone="neutral" title={copy.missing.title} />
      ) : items.length === 0 ? (
        <CalmState
          tone="calm"
          icon={<Check aria-hidden="true" />}
          title={copy.empty.title}
          detail={copy.empty.detail}
        />
      ) : (
        <HorizonWorkList>
          {items.map((item) => {
            const row = homeAttentionCopy(item);
            const Icon = ICONS[item.kind];
            return (
              <HorizonWorkRow
                key={item.kind}
                data-home-row={item.kind}
                href={item.href}
                leading={
                  <ToneChip tone={item.tone}>
                    <Icon aria-hidden="true" />
                  </ToneChip>
                }
                title={row.title}
                meta={row.meta}
                action={row.action}
                emphasized={item.emphasized}
              />
            );
          })}
        </HorizonWorkList>
      )}
    </HorizonPanel>
  );
}
