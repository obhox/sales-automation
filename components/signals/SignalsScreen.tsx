import { useState } from "react";
import { useRouter } from "next/router";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Page, useShell } from "@/components/shell";
import { Alert, Button } from "@/components/ui";
import { useApi } from "@/lib/client/data";
import { useCan } from "@/lib/client/roles";
import { DetectionTab } from "./DetectionTab";
import { FeedTab } from "./FeedTab";
import { RecordSignalDialog } from "./RecordSignalDialog";
import { RulesTab } from "./RulesTab";
import { RULES_PATH, SIGNALS_PATH, feedSummary, isTab, type Rule, type SignalFeed, type SignalsTab } from "./model";

/** Outreach → Signals: what has happened to your contacts and accounts, what to do about it, and where it comes from. */
export function SignalsScreen() {
  const router = useRouter();
  const tab: SignalsTab = isTab(router.query.tab) ? router.query.tab : "feed";
  const can = { member: useCan("member"), manager: useCan("manager"), admin: useCan("admin") };
  const shell = useShell();
  // Just the counts, for the title and the tab: the feed tab reads its own page.
  const counts = useApi<SignalFeed>(SIGNALS_PATH, { view: "feed", limit: 1 });
  const rules = useApi<Rule[]>(RULES_PATH);
  const [recording, setRecording] = useState(false);
  const [round, setRound] = useState(0);
  // The sidebar's count is the same count: when it changes here, it is read again there.
  const changed = () => {
    void counts.mutate();
    void shell.mutate();
  };

  return (
    <Page
      title="Signals"
      meta={counts.data ? <span className="text-11 text-ink-3">{feedSummary(counts.data)}</span> : null}
      actions={
        can.member ? (
          <>
            <Button variant="primary" icon={Plus} onClick={() => setRecording(true)}>Record a signal</Button>
            <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />
          </>
        ) : undefined
      }
      tabs={{
        label: "Signals",
        value: tab,
        items: [
          { value: "feed", label: "Feed", href: "/signals", count: counts.data && counts.data.new_count > 0 ? counts.data.new_count : undefined },
          { value: "rules", label: "Rules", href: "/signals?tab=rules", count: rules.data && rules.data.length > 0 ? rules.data.length : undefined },
          { value: "detection", label: "Detection", href: "/signals?tab=detection" },
        ],
      }}
    >
      {tab === "feed" ? (
        <>
          {!can.member && counts.data ? <Alert tone="neutral">You can read the signals. A member records them and marks them as seen.</Alert> : null}
          <FeedTab member={can.member} round={round} onChanged={changed} />
        </>
      ) : tab === "rules" ? (
        <RulesTab manager={can.manager} />
      ) : (
        <DetectionTab manager={can.manager} admin={can.admin} onSignals={() => { changed(); setRound((value) => value + 1); }} />
      )}
      {recording ? (
        <RecordSignalDialog
          onClose={() => setRecording(false)}
          onSaved={() => {
            toast.success("Signal recorded");
            setRound((value) => value + 1);
            changed();
          }}
        />
      ) : null}
    </Page>
  );
}
