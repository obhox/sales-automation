import { useEffect, type ReactNode } from "react";
import { signOut, useSession } from "next-auth/react";
import useSWR, { SWRConfig, type SWRConfiguration, type SWRResponse } from "swr";
import { api, apiUrl, ApiError, onSessionEnded, type Query } from "./api";

/**
 * SWR set up for this app. Wraps every rebuilt page.
 *
 * - Nothing refetches when the window regains focus. API handlers run on the
 *   same thread as the campaign runner, so background refetching is paid for
 *   by sending. A screen that needs fresh data asks for it, or polls on purpose.
 * - The cache is thrown away when the workspace changes: the workspace lives
 *   in the session, not in the URLs, so the same key means different data.
 * - A 401 from any request ends the session in one place.
 */
export function DataProvider({ children }: { children: ReactNode }) {
  const { data: session } = useSession();
  const workspaceId = session?.user?.workspaceId ?? "none";

  useEffect(
    () =>
      onSessionEnded(() => {
        void signOut({ callbackUrl: "/login?notice=session-ended" });
      }),
    [],
  );

  return (
    <SWRConfig
      key={workspaceId}
      value={{
        provider: () => new Map(),
        fetcher: (key: string) => api(key),
        revalidateOnFocus: false,
        revalidateIfStale: true,
        keepPreviousData: true,
        dedupingInterval: 2000,
        // A 4xx will not get better by asking again.
        shouldRetryOnError: (error: unknown) => !(error instanceof ApiError) || error.status === 0 || error.status >= 500,
        errorRetryCount: 2,
      }}
    >
      {children}
    </SWRConfig>
  );
}

/**
 * Read from the API. Pass `null` as the path to wait (for example until an id
 * is known). The key is the full URL, so two components asking for the same
 * thing share one request.
 */
export function useApi<T>(path: string | null, query?: Query, config?: SWRConfiguration<T, ApiError>): SWRResponse<T, ApiError> {
  return useSWR<T, ApiError>(path === null ? null : apiUrl(path, query), config);
}
