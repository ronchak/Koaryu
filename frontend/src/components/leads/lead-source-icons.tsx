import type { ReactNode } from "react";
import type { LeadSource } from "@/types";
import {
  ExternalLink,
  Globe,
  MapPin,
  Megaphone,
  Search,
  Users,
} from "lucide-react";

export const LEAD_SOURCE_ICONS: Record<LeadSource, ReactNode> = {
  walk_in: <MapPin className="w-3 h-3" />,
  referral: <Users className="w-3 h-3" />,
  social: <Megaphone className="w-3 h-3" />,
  search: <Search className="w-3 h-3" />,
  website: <Globe className="w-3 h-3" />,
  other: <ExternalLink className="w-3 h-3" />,
};
