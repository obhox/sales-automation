import { useState } from "react";
import { Flame } from "lucide-react";
import { toast } from "sonner";
import { Card, CardHeader, Switch, confirm } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { formatCount, plural } from "@/lib/client/format";
import { rampNote, warmupSubtitle, type DomainDeliverability } from "./model";

/** A domain's warm-up: how many of its mailboxes are in the pool, what the week came to, and which one is still ramping. */
export function WarmupCard({ domain, canEdit, onChanged }: { domain: DomainDeliverability; canEdit: boolean; onChanged: () => void }) {
  const [saving, setSaving] = useState(false);
  const total = domain.mailboxes.length;
  const on = domain.warmup.in_pool > 0;
  const note = rampNote(domain.warmup.ramping);

  async function toggle(next: boolean) {
    if (!next) {
      const ok = await confirm({
        title: `Take ${domain.domain} out of the warm-up pool?`,
        body: `${domain.warmup.in_pool} ${plural(domain.warmup.in_pool, "mailbox stops", "mailboxes stop")} exchanging warm-up mail. Campaign emails are not affected. A mailbox that is still ramping up keeps its ramp, but loses the opens and replies that build its standing with mail providers.`,
        confirmLabel: "Stop warm-up",
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      await api("/api/deliverability/warmup", { method: "POST", body: { domain: domain.domain, enabled: next } });
      toast.success(next ? `Every mailbox on ${domain.domain} is in the warm-up pool` : `Warm-up stopped for ${domain.domain}`);
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  const stat = (value: number, label: string, tone?: string) => (
    <div className="flex min-w-0 flex-1 flex-col gap-[3px] rounded-lg bg-subtle p-2.5">
      <span className={cn("text-[19px] font-semibold leading-none tracking-figure", tone ?? "text-ink")}>{formatCount(value)}</span>
      <span className="text-105 leading-[14px] text-ink-3">{label}</span>
    </div>
  );

  return (
    <Card className="flex flex-col gap-3 p-3.5">
      <CardHeader
        title="Mailbox warm-up" subtitle={warmupSubtitle(domain)}
        actions={<Switch checked={on} disabled={!canEdit || saving || total === 0} onChange={(next) => void toggle(next)} label={`Warm-up for every mailbox on ${domain.domain}`} className="h-5 w-9 [&>span]:size-4 [&>span]:data-[state=checked]:translate-x-4" />}
      />
      <div className="flex gap-2.5">
        {stat(domain.warmup.sent_week, "Sent this week")}
        {stat(domain.warmup.replied_week, "Replied")}
        {stat(domain.warmup.rescued_week, "Spam rescues", domain.warmup.rescued_week > 0 ? "text-warn" : undefined)}
      </div>
      {note ? (
        <p className="flex gap-[9px] rounded-lg bg-mail-tint p-2.5 text-11 leading-[15px] text-mail">
          <Flame size={13} className="mt-px shrink-0" aria-hidden="true" />
          {note}
        </p>
      ) : null}
    </Card>
  );
}
