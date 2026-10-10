import { BookOpen, CircleQuestionMark, CirclePlay, Keyboard } from "lucide-react";
import { IconButton, Menu, MenuItem } from "@/components/ui";
import { useShellControls } from "./ShellContext";

const LEARNING_PLAYLIST_URL = "https://www.youtube.com/playlist?list=PLBf6xNJOmsIQ";
const DEPLOYMENT_GUIDE_URL = "https://github.com/obhox/sales-automation/blob/main/DEPLOYMENT.md";

/** The question mark in the topbar. Page tours return here once they are rewritten for the new navigation. */
export function HelpMenu() {
  const { openPalette } = useShellControls();
  const open = (url: string) => window.open(url, "_blank", "noopener,noreferrer");
  return (
    <Menu trigger={<IconButton icon={CircleQuestionMark} label="Help" variant="surface" />} width={212}>
      <MenuItem icon={CirclePlay} onSelect={() => open(LEARNING_PLAYLIST_URL)}>Learning videos</MenuItem>
      <MenuItem icon={BookOpen} onSelect={() => open(DEPLOYMENT_GUIDE_URL)}>Deployment guide</MenuItem>
      <MenuItem icon={Keyboard} onSelect={openPalette}>Search and jump (⌘K)</MenuItem>
    </Menu>
  );
}
