import { useState } from "react";
import {useTranslations} from "next-intl";
import { Flame } from "lucide-react";
import { toast } from "sonner";
import { Card, CardHeader, Switch, confirm } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { formatCount } from "@/lib/client/format";
import { type DomainDeliverability } from "./model";

/** A domain's warm-up: how many of its mailboxes are in the pool, what the week came to, and which one is still ramping. */
export function WarmupCard({ domain, canEdit, onChanged }: { domain: DomainDeliverability; canEdit: boolean; onChanged: () => void }) {
  const t = useTranslations("DeliverabilityWarmup");
  const [saving, setSaving] = useState(false);
  const total = domain.mailboxes.length;
  const on = domain.warmup.in_pool > 0;
  const ramp = domain.warmup.ramping;
  const note = ramp ? t("ramp", {email: ramp.from_email, day: ramp.day, from: ramp.limit, to: ramp.limit_full, left: ramp.days - ramp.day}) : null;

  async function toggle(next: boolean) {
    if (!next) {
      const ok = await confirm({
        title: t("confirmTitle", {domain: domain.domain}),
        body: t("confirmBody", {count: domain.warmup.in_pool}),
        confirmLabel: t("stop"),
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      await api("/api/deliverability/warmup", { method: "POST", body: { domain: domain.domain, enabled: next } });
      toast.success(next ? t("on", {domain: domain.domain}) : t("off", {domain: domain.domain}));
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
        title={t("title")} subtitle={t("subtitle", {inPool: domain.warmup.in_pool, total})}
        actions={<Switch checked={on} disabled={!canEdit || saving || total === 0} onChange={(next) => void toggle(next)} label={t("switch", {domain: domain.domain})} className="h-5 w-9 [&>span]:size-4 [&>span]:data-[state=checked]:translate-x-4" />}
      />
      <div className="flex gap-2.5">
        {stat(domain.warmup.sent_week, t("sent"))}
        {stat(domain.warmup.replied_week, t("replied"))}
        {stat(domain.warmup.rescued_week, t("rescued"), domain.warmup.rescued_week > 0 ? "text-warn" : undefined)}
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
