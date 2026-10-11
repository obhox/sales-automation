import { useState } from "react";
import Link from "next/link";
import { BookOpen, CircleArrowUp, Plus } from "lucide-react";
import { Page, useShell } from "@/components/shell";
import { Alert, Button, Tooltip } from "@/components/ui";
import { useApi } from "@/lib/client/data";
import { useCan } from "@/lib/client/roles";
import { ApiKeysCard } from "./ApiKeysCard";
import { CreateKeyDialog } from "./KeyDialogs";
import { HealthCard, IntegrationsCard, McpCard } from "./SideCards";
import { WebhooksCard } from "./WebhooksCard";
import { KEYS_PATH, WEBHOOKS_PATH, instanceContext, type ApiKeyRow, type WebhookRow } from "./model";

/** Configure → Developer API: keys, webhooks, the MCP server, integrations and the instance's health. */
export function DevelopersScreen() {
  const keys = useApi<ApiKeyRow[]>(KEYS_PATH);
  const hooks = useApi<WebhookRow[]>(WEBHOOKS_PATH);
  const { data: shell } = useShell();
  const admin = useCan("admin");
  const [creating, setCreating] = useState(false);
  // Read while rendering: the line it goes in waits for the shell's data, which only the browser has.
  const host = typeof window === "undefined" ? "" : window.location.host;

  return (
    <Page
      title="Developer API"
      meta={
        shell ? (
          <>
            <span className="text-11 text-ink-3">{instanceContext(host, shell.version.current)}</span>
            {shell.version.update_available && shell.version.latest ? (
              <Tooltip label="A newer version has been published. Update the instance where it is deployed.">
                <span tabIndex={0} className="inline-flex h-[22px] items-center gap-[5px] rounded-full bg-brand-tint px-2 text-105 font-semibold text-brand-strong">
                  <CircleArrowUp size={11} aria-hidden="true" />
                  v{shell.version.latest} available
                </span>
              </Tooltip>
            ) : null}
          </>
        ) : null
      }
      actions={
        <>
          <Button asChild>
            <Link href="/developers/reference">
              <BookOpen size={14} className="text-ink-2" aria-hidden="true" />
              API reference
            </Link>
          </Button>
          {admin ? <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>Create API key</Button> : null}
          <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />
        </>
      }
    >
      {!admin ? <Alert tone="neutral">{"You can see this workspace's keys, webhooks and integrations. An admin creates and changes them, and sees the instance's health."}</Alert> : null}
      <div className="flex min-h-0 flex-col gap-3.5 xl:flex-row xl:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-3.5">
          <ApiKeysCard keys={keys.data} loading={keys.isLoading} error={keys.error} admin={admin} onRetry={() => void keys.mutate()} onChanged={() => void keys.mutate()} onCreate={() => setCreating(true)} />
          <WebhooksCard hooks={hooks.data} loading={hooks.isLoading} error={hooks.error} admin={admin} onRetry={() => void hooks.mutate()} onChanged={() => void hooks.mutate()} />
        </div>
        <div className="flex w-full shrink-0 flex-col gap-3.5 xl:w-[368px]">
          <McpCard />
          <IntegrationsCard admin={admin} />
          {/* The health route is for admins: nobody else is shown a card that would be refused. */}
          {admin ? <HealthCard /> : null}
        </div>
      </div>
      {admin ? <CreateKeyDialog open={creating} onClose={() => setCreating(false)} onCreated={() => void keys.mutate()} /> : null}
    </Page>
  );
}
