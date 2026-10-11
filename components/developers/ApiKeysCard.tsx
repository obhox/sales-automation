import { useState } from "react";
import { Ban, Ellipsis, KeyRound, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, EmptyState, ErrorState, IconButton, Menu, MenuItem, MenuSeparator, Pill, Tooltip, confirm } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { EditKeyDialog } from "./KeyDialogs";
import { Chip, CopyIcon, RowSkeleton } from "./parts";
import { KEYS_PATH, expiryCell, isExpired, isRevoked, lastUsed, maskedKey, rateLimitLabel, rateLimitSummary, scopeChips, scopeList, type ApiKeyRow } from "./model";

const GRID = "grid grid-cols-[minmax(170px,1fr)_210px_120px_104px_28px] items-center gap-3 px-3.5";
const EXPIRY_TONE = { neutral: "text-ink-2", warn: "text-warn", bad: "text-bad" };

/** The workspace's API keys: what each may do, when it stops working and when it was last used. */
export function ApiKeysCard({ keys, loading, error, admin, onRetry, onChanged, onCreate }: {
  keys: ApiKeyRow[] | undefined;
  loading: boolean;
  error: unknown;
  admin: boolean;
  onRetry: () => void;
  onChanged: () => void;
  onCreate: () => void;
}) {
  const [editing, setEditing] = useState<ApiKeyRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const summary = keys ? rateLimitSummary(keys) : null;

  async function revoke(key: ApiKeyRow) {
    const ok = await confirm({
      title: `Revoke “${key.name}”?`,
      body: "Anything using this key is refused from its next request. A revoked key cannot be brought back; you would make a new one.",
      confirmLabel: "Revoke key",
      tone: "danger",
    });
    if (!ok || busy) return;
    setBusy(key.id);
    try {
      await api(KEYS_PATH, { method: "DELETE", query: { id: key.id } });
      toast.success(`“${key.name}” was revoked`);
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-3.5 py-[11px]">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">API keys</h2>
          <p className="truncate text-11 text-ink-3">Scoped and expiring · the full key is shown once at creation</p>
        </div>
        {summary ? <span className="inline-flex h-6 shrink-0 items-center rounded-full bg-subtle px-2 text-105 font-semibold text-ink-2">{summary}</span> : null}
      </div>

      {error && !keys ? (
        <ErrorState className="border-t border-line" message={errorMessage(error)} onRetry={onRetry} />
      ) : (
        <div className="overflow-x-auto">
          <div role="table" aria-label="API keys" className="min-w-[708px]">
            <div role="row" className={cn(GRID, "h-[31px] bg-subtle text-10 font-semibold uppercase tracking-label text-ink-3")}>
              <span role="columnheader">Name</span>
              <span role="columnheader">Scopes</span>
              <span role="columnheader">Expires</span>
              <span role="columnheader">Last used</span>
              <span role="columnheader"><span className="sr-only">Actions</span></span>
            </div>
            {loading || !keys ? <RowSkeleton label="Loading API keys" /> : keys.map((key) => {
              const revoked = isRevoked(key);
              const expired = !revoked && isExpired(key);
              const chips = scopeChips(key.scopes);
              const expiry = expiryCell(key);
              return (
                <div key={key.id} role="row" aria-busy={busy === key.id || undefined} className={cn(GRID, "h-14 border-t border-line", busy === key.id && "opacity-60")}>
                  <div role="cell" className="flex min-w-0 flex-col gap-[3px]">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className={cn("truncate text-12 font-medium", revoked || expired ? "text-ink-2" : "text-ink")}>{key.name}</span>
                      {revoked ? <Pill tone="bad" size="sm">Revoked</Pill> : expired ? <Pill tone="bad" size="sm">Expired</Pill> : null}
                    </div>
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-mono text-105 text-ink-3">{maskedKey(key.key_prefix)}</span>
                      <CopyIcon text={key.key_prefix} label="Copy the start of the key" />
                      {key.rate_limit_per_minute && !revoked ? <span className="shrink-0 text-105 text-ink-3">· {rateLimitLabel(key.rate_limit_per_minute)}</span> : null}
                    </div>
                  </div>
                  <div role="cell" className="flex min-w-0 items-center gap-1">
                    {chips.shown.map((scope) => <Chip key={scope} mono>{scope}</Chip>)}
                    {chips.more > 0 ? (
                      <Tooltip label={scopeList(key.scopes).slice(chips.shown.length).join(", ")}>
                        <span tabIndex={0} className="shrink-0 rounded-sm text-10 font-bold text-ink-3">+{chips.more}</span>
                      </Tooltip>
                    ) : null}
                  </div>
                  <div role="cell" className="flex min-w-0 flex-col gap-0.5">
                    <span className={cn("truncate text-115 font-medium", expiry.tone === "bad" ? "text-bad" : "text-ink")}>{expiry.date}</span>
                    <span className={cn("truncate text-105", EXPIRY_TONE[expiry.tone])}>{expiry.note}</span>
                  </div>
                  <span role="cell" className="truncate text-11 text-ink-3">{lastUsed(key.last_used_at)}</span>
                  <div role="cell" className="flex justify-end">
                    {admin && !revoked ? (
                      <Menu trigger={<IconButton icon={Ellipsis} label={`Actions for ${key.name}`} size={28} />}>
                        <MenuItem icon={Pencil} onSelect={() => setEditing(key)}>Rename or set a limit</MenuItem>
                        <MenuSeparator />
                        <MenuItem icon={Ban} tone="danger" onSelect={() => void revoke(key)}>Revoke key</MenuItem>
                      </Menu>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {keys && keys.length === 0 ? (
        <EmptyState
          icon={KeyRound} title="No API keys yet" className="border-t border-line"
          action={admin ? <Button variant="primary" icon={Plus} onClick={onCreate}>Create API key</Button> : undefined}
        >
          {admin ? "A key lets your own code read and change this workspace. Give each integration its own, with only the scopes it needs." : "An admin can create keys for code that reads or changes this workspace."}
        </EmptyState>
      ) : null}
      {editing ? <EditKeyDialog key={editing.id} apiKey={editing} onClose={() => setEditing(null)} onSaved={onChanged} /> : null}
    </Card>
  );
}
