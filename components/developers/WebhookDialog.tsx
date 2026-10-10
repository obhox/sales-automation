import { useState } from "react";
import { Webhook } from "lucide-react";
import { Alert, Button, Checkbox, CodeBlock, Dialog, Field, Input, Segmented } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { EVENT_TYPES } from "@/lib/platform/event-types";
import { SecretOnce } from "./parts";
import { WEBHOOKS_PATH, eventList, type WebhookRow } from "./model";

interface Created {
  id: string;
  secret: string;
}

// The events grouped by what they are about, in the order the list defines them.
const GROUPS: Array<{ label: string; events: string[] }> = [
  { label: "Email", events: EVENT_TYPES.filter((type) => type.startsWith("email.") || type.startsWith("sender.")) },
  { label: "Replies", events: EVENT_TYPES.filter((type) => type.startsWith("reply.")) },
  { label: "LinkedIn", events: EVENT_TYPES.filter((type) => type.startsWith("linkedin.")) },
  { label: "Everything else", events: EVENT_TYPES.filter((type) => !/^(email|sender|reply|linkedin)\./.test(type)) },
];

const VERIFY = `signature = hex(hmac_sha256(secret, timestamp + "." + body))

x-linki-timestamp: 1791627000
x-linki-signature: sha256=<signature>
x-linki-event:     reply.received`;

/**
 * Add an endpoint, or change one. Its signing secret is shown once, when it is made.
 * Mounted only while open, so it starts from the endpoint's own values.
 */
export function WebhookDialog({ hook, onClose, onSaved }: { hook: WebhookRow | null; onClose: () => void; onSaved: () => void }) {
  const current = hook ? eventList(hook.event_types) : ["*"];
  const [name, setName] = useState(hook?.name ?? "");
  const [url, setUrl] = useState(hook?.url ?? "");
  const [mode, setMode] = useState<"all" | "some">(current.includes("*") ? "all" : "some");
  const [events, setEvents] = useState<string[]>(current.filter((type) => type !== "*"));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{ field: "url" | "events" | "form"; message: string } | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  async function save() {
    if (!hook && !/^https:\/\/[^\s/]+/.test(url.trim())) return setProblem({ field: "url", message: "Enter an address starting with https://" });
    if (mode === "some" && events.length === 0) return setProblem({ field: "events", message: "Choose at least one event, or send all of them." });
    setSaving(true);
    setProblem(null);
    const eventTypes = mode === "all" ? "*" : EVENT_TYPES.filter((type) => events.includes(type));
    try {
      if (hook) {
        await api(WEBHOOKS_PATH, { method: "PATCH", body: { id: hook.id, name: name.trim(), event_types: eventTypes } });
        onSaved();
        onClose();
      } else {
        setCreated(await api<Created>(WEBHOOKS_PATH, { method: "POST", body: { url: url.trim(), name: name.trim() || null, event_types: eventTypes } }));
        onSaved();
      }
    } catch (cause) {
      const message = errorMessage(cause);
      setProblem({ field: /url|address|host/i.test(message) ? "url" : "form", message });
    } finally {
      setSaving(false);
    }
  }

  const toggle = (type: string, on: boolean) => setEvents((list) => (on ? [...list.filter((item) => item !== type), type] : list.filter((item) => item !== type)));

  return (
    <Dialog
      open
      onOpenChange={(next) => (next || saving ? undefined : onClose())}
      icon={Webhook}
      title={created ? "Endpoint added" : hook ? "Edit endpoint" : "Add a webhook endpoint"}
      description={created ? url.trim() : hook ? hook.url : "Linki sends it a signed request for each event"}
      footer={
        created ? (
          <>
            <span className="text-105 text-ink-3">The secret is not shown again.</span>
            <Button variant="primary" onClick={onClose}>I have copied it</Button>
          </>
        ) : (
          <>
            <span className="text-105 text-ink-3">{mode === "all" ? "Every event, including new kinds added later" : `${events.length} of ${EVENT_TYPES.length} events`}</span>
            <div className="flex items-center gap-2">
              <Button onClick={onClose} disabled={saving}>Cancel</Button>
              <Button variant="primary" loading={saving} onClick={() => void save()}>{hook ? "Save" : "Add endpoint"}</Button>
            </div>
          </>
        )
      }
    >
      {created ? (
        <div className="flex flex-col gap-3.5">
          <Alert tone="warn" title="Copy the signing secret now">This is the only time it is shown. Without it your endpoint cannot tell a request from Linki from one sent by anyone else.</Alert>
          <Field label="Signing secret">{() => <SecretOnce value={created.secret} label="Signing secret" />}</Field>
          <Field label="Checking a request" hint="Compute the signature over the timestamp, a full stop and the raw body, and compare it with the header. Refuse a request whose timestamp is more than a few minutes old.">
            {() => <CodeBlock code={VERIFY} caption="Headers on every delivery" />}
          </Field>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {problem?.field === "form" ? <Alert tone="bad">{problem.message}</Alert> : null}
          <Field label="Name" aside="Optional" hint="What you call it: “Reply router”, “Data warehouse”.">
            {(id) => <Input id={id} data-autofocus maxLength={80} placeholder="Reply router" value={name} onChange={(event) => setName(event.target.value)} />}
          </Field>
          <Field
            label="Address" error={problem?.field === "url" ? problem.message : null}
            hint={hook ? "An endpoint keeps its address. To send somewhere else, add another: each has its own signing secret." : "A public https address. Private and local addresses are refused."}
          >
            {(id) => <Input id={id} type="url" className="font-mono text-11" placeholder="https://hooks.yourcompany.com/linki" value={url} readOnly={Boolean(hook)} disabled={Boolean(hook)} invalid={problem?.field === "url"} onChange={(event) => setUrl(event.target.value)} />}
          </Field>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-105 font-semibold text-ink-2">Events</span>
              <Segmented size="sm" label="Which events" value={mode} onChange={setMode} options={[{ value: "all", label: "All events" }, { value: "some", label: "Chosen events" }]} />
            </div>
            {mode === "some" ? (
              <div className="grid grid-cols-1 gap-x-5 gap-y-3 rounded-lg border border-line p-3 sm:grid-cols-2">
                {GROUPS.map((group) => (
                  <fieldset key={group.label} className="flex min-w-0 flex-col gap-px">
                    <legend className="mb-1 text-10 font-semibold uppercase tracking-label text-ink-3">{group.label}</legend>
                    {group.events.map((type) => {
                      const id = `event-${type}`;
                      return (
                        <label key={type} htmlFor={id} className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 hover:bg-subtle">
                          <Checkbox id={id} checked={events.includes(type)} onChange={(on) => toggle(type, on)} />
                          <span className="truncate font-mono text-11 text-ink">{type}</span>
                        </label>
                      );
                    })}
                  </fieldset>
                ))}
              </div>
            ) : null}
            {problem?.field === "events" ? <p className="text-105 text-bad" role="alert">{problem.message}</p> : null}
          </div>
          {/* Enter sends a form only if it has a submit button; the visible ones are in the footer. */}
          <button type="submit" hidden />
        </form>
      )}
    </Dialog>
  );
}
