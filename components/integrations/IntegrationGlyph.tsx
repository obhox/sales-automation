import { Bot, BrainCircuit, Calendar, CalendarDays, Cloud, Globe, Hexagon, Rocket, Rss, type LucideIcon } from "lucide-react";
import type { IntegrationIcon } from "./model";

/** The outline icon that stands for each integration. Not its logo. */
export const INTEGRATION_ICON: Record<IntegrationIcon, LucideIcon> = { rocket: Rocket, brain: BrainCircuit, hexagon: Hexagon, cloud: Cloud, calendar: Calendar, "calendar-days": CalendarDays, rss: Rss, globe: Globe, bot: Bot };

export function IntegrationGlyph({ icon, size = 15 }: { icon: IntegrationIcon; size?: number }) {
  const Glyph = INTEGRATION_ICON[icon];
  return <Glyph size={size} aria-hidden="true" />;
}
