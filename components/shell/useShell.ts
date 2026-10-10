import { useApi } from "@/lib/client/data";
import type { ShellPayload } from "@/pages/api/shell";

/**
 * The data behind the frame: member, workspaces, badge counts, runner health, version.
 * This is the one request the app polls, once a minute, so counts and health stay
 * roughly current without every screen asking.
 */
export function useShell() {
  return useApi<ShellPayload>("/api/shell", undefined, { refreshInterval: 60_000, revalidateOnFocus: true });
}
