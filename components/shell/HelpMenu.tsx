import { useRouter } from "next/router";
import { useTranslations } from "next-intl";
import { BookOpen, CircleQuestionMark, Compass, Keyboard, Signpost } from "lucide-react";
import { IconButton, Menu, MenuItem, MenuSeparator } from "@/components/ui";
import { TOURS, tourFor } from "@/lib/client/tours";
import { useShellControls } from "./ShellContext";

const DEPLOYMENT_GUIDE_URL = "https://github.com/obhox/sales-automation/blob/main/DEPLOYMENT.md";

/** The question mark in the topbar: the tours, the deployment guide and the way to search. */
export function HelpMenu() {
  const t = useTranslations("ShellHelp");
  const router = useRouter();
  const { openPalette, startTour } = useShellControls();
  const open = (url: string) => window.open(url, "_blank", "noopener,noreferrer");
  const pageTour = tourFor(router.pathname);
  const tourNames: Record<keyof typeof TOURS, string> = {
    welcome: t("tour_welcome"),
    dashboard: t("tour_dashboard"),
    campaigns: t("tour_campaigns"),
    campaign: t("tour_campaign"),
    sequence: t("tour_sequence"),
    inbox: t("tour_inbox"),
    contacts: t("tour_contacts"),
    lists: t("tour_lists"),
    companies: t("tour_companies"),
    pipeline: t("tour_pipeline"),
    linkedin: t("tour_linkedin"),
    mailboxes: t("tour_mailboxes"),
    deliverability: t("tour_deliverability"),
    ai: t("tour_ai"),
    templates: t("tour_templates"),
    signals: t("tour_signals"),
    team: t("tour_team"),
    developers: t("tour_developers"),
    csv_import: t("tour_csv_import"),
  };
  // The menu has to have closed, and given the page its focus back, before a tour can point at things.
  const later = (run: () => void) => window.setTimeout(run, 150);
  return (
    <span data-tour="help" className="inline-flex">
      <Menu trigger={<IconButton icon={CircleQuestionMark} label={t("help")} variant="surface" />} width={232}>
        <MenuItem icon={Signpost} disabled={!pageTour} onSelect={() => pageTour && later(() => startTour(pageTour))}>
          {pageTour ? t("tourOf", {name: tourNames[pageTour]}) : t("noTour")}
        </MenuItem>
        <MenuItem icon={Compass} onSelect={() => later(() => startTour("welcome"))}>{t("gettingAround")}</MenuItem>
        <MenuSeparator />
        <MenuItem icon={BookOpen} onSelect={() => open(DEPLOYMENT_GUIDE_URL)}>{t("deploymentGuide")}</MenuItem>
        <MenuItem icon={Keyboard} onSelect={openPalette}>{t("searchJump")}</MenuItem>
      </Menu>
    </span>
  );
}
