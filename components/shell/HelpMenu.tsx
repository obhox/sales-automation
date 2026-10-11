import { useRouter } from "next/router";
import { BookOpen, CircleQuestionMark, Compass, Keyboard, Signpost } from "lucide-react";
import { IconButton, Menu, MenuItem, MenuSeparator } from "@/components/ui";
import { TOURS, tourFor } from "@/lib/client/tours";
import { useShellControls } from "./ShellContext";

const DEPLOYMENT_GUIDE_URL = "https://github.com/obhox/sales-automation/blob/main/DEPLOYMENT.md";

/** The question mark in the topbar: the tours, the deployment guide and the way to search. */
export function HelpMenu() {
  const router = useRouter();
  const { openPalette, startTour } = useShellControls();
  const open = (url: string) => window.open(url, "_blank", "noopener,noreferrer");
  const pageTour = tourFor(router.pathname);
  // The menu has to have closed, and given the page its focus back, before a tour can point at things.
  const later = (run: () => void) => window.setTimeout(run, 150);
  return (
    <span data-tour="help" className="inline-flex">
      <Menu trigger={<IconButton icon={CircleQuestionMark} label="Help" variant="surface" />} width={232}>
        <MenuItem icon={Signpost} disabled={!pageTour} onSelect={() => pageTour && later(() => startTour(pageTour))}>
          {pageTour ? `Tour of ${TOURS[pageTour].name}` : "No tour for this page"}
        </MenuItem>
        <MenuItem icon={Compass} onSelect={() => later(() => startTour("welcome"))}>Getting around Linki</MenuItem>
        <MenuSeparator />
        <MenuItem icon={BookOpen} onSelect={() => open(DEPLOYMENT_GUIDE_URL)}>Deployment guide</MenuItem>
        <MenuItem icon={Keyboard} onSelect={openPalette}>Search and jump (⌘K)</MenuItem>
      </Menu>
    </span>
  );
}
