import type { BeltRank } from "@/types";
import { getRankColorTreatment } from "@/lib/rank-color-treatment";

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
  const background = colorHex || "#FFFFFF";
  const treatment = getRankColorTreatment(background);

  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[10px] text-xs font-medium"
      style={treatment}
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
