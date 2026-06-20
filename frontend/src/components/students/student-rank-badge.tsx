import type { BeltRank } from "@/types";

export type StudentRankWithContext = BeltRank & { ladderName: string };

export function StudentRankBadge({
  name,
  colorHex,
  isTip,
  tipColorHex,
}: {
  name: string;
  colorHex?: string;
  isTip?: boolean;
  tipColorHex?: string;
}) {
  const normalized = colorHex?.toLowerCase();
  const isWhite = !normalized || normalized === "#ffffff" || normalized === "#f5f5f5";
  const background = colorHex || "#FFFFFF";

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[4px] text-xs font-medium ${
        isWhite ? "text-text-primary border border-border" : "text-white"
      }`}
      style={{ backgroundColor: isWhite ? "transparent" : background }}
    >
      <span
        className="w-2 h-2 rounded-full border border-white/30"
        style={{ backgroundColor: background }}
      />
      {name}
      {isTip && tipColorHex ? (
        <span
          className="w-1.5 h-3 rounded-sm flex-shrink-0"
          style={{ backgroundColor: tipColorHex }}
        />
      ) : null}
    </span>
  );
}
