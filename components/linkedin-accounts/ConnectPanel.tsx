import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useSession } from "next-auth/react";
import { CalendarClock, ChevronDown, Cookie, KeyRound, Lock, Mail, Network, Server, ShieldCheck, Smartphone, TrendingUp, Undo2, User, X } from "lucide-react";
import { toast } from "sonner";
import { Alert, Button, Card, Eyebrow, Field, IconButton, Input, Pill, Popover, Select, TextAction, Textarea, type Icon } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { countdown, hostOf, presetLines, type LinkedinAccountView, type LinkedinPreset, type Member } from "./model";

type Method = "login" | "cookie";
type Stage = "form" | "code" | "approve";

interface LoginResult {
  status: "authenticated" | "challenge" | "error";
  kind?: "otp" | "app" | "captcha" | "unknown";
  message?: string;
  expires_at?: string;
}

/** How long before LinkedIn can be asked for another code. */
const RESEND_AFTER_MS = 60_000;
const CODE_LENGTH = 6;

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export interface ConnectPanelProps {
  /** The account being signed in again, or null to connect a new one. */
  account: LinkedinAccountView | null;
  preset: LinkedinPreset;
  members: Member[];
  /** Something changed on the server (an account was created, a session was stored). */
  onChanged: () => void;
  /** The account is signed in; the panel goes back to "connect a new account". */
  onDone: () => void;
  /** Leave a reconnect and go back to "connect a new account". */
  onCancel: () => void;
}

/**
 * Connect a LinkedIn account, or sign an existing one in again. Two ways in: Linki signs
 * in on the server (and holds the sign-in while LinkedIn asks for a code or an approval),
 * or a session cookie is pasted from a browser that is already signed in.
 */
export function ConnectPanel({ account, preset, members, onChanged, onDone, onCancel }: ConnectPanelProps) {
  const { data: session } = useSession();
  const [method, setMethod] = useState<Method>(account?.session.method === "cookie" ? "cookie" : "login");
  const [stage, setStage] = useState<Stage>("form");
  const [name, setName] = useState(account?.name ?? "");
  const [email, setEmail] = useState(account?.email ?? "");
  const [password, setPassword] = useState("");
  const [cookie, setCookie] = useState("");
  const [extraCookies, setExtraCookies] = useState("");
  const [ownerId, setOwnerId] = useState<string>(account?.owner?.id ?? session?.user?.id ?? "");
  const [showProxy, setShowProxy] = useState(false);
  const [proxy, setProxy] = useState({ url: "", username: "", password: "", label: "" });
  const [code, setCode] = useState("");
  // The account this sign-in is for: the one being reconnected, or the one just created.
  const [accountId, setAccountId] = useState<string | null>(account?.id ?? null);
  const [challenge, setChallenge] = useState<{ message: string; expiresAt: number | null; resendAt: number } | null>(null);
  const [busy, setBusy] = useState<"submit" | "resend" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const now = useNow(stage !== "form");
  const timezone = account?.schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";

  const expired = challenge?.expiresAt != null && now >= challenge.expiresAt;
  const reconnecting = account !== null;

  function backToForm(message: string | null) {
    setStage("form");
    setChallenge(null);
    setCode("");
    setError(message);
  }

  function takeResult(result: LoginResult) {
    if (result.status === "authenticated") {
      toast.success(`${name || account?.name || "The account"} is signed in to LinkedIn`);
      onChanged();
      onDone();
      return;
    }
    if (result.status === "challenge" && result.kind === "captcha") {
      setMethod("cookie");
      backToForm("LinkedIn showed a puzzle that a server cannot solve. Paste a session cookie from a browser where this account is signed in.");
      return;
    }
    if (result.status === "challenge") {
      setChallenge({
        message: result.message ?? "",
        expiresAt: result.expires_at ? Date.parse(result.expires_at) : null,
        resendAt: challenge?.resendAt ?? Date.now() + RESEND_AFTER_MS,
      });
      setError(null);
      if (result.kind === "app") {
        if (stage === "approve") setError("Still waiting. Approve the sign-in in the LinkedIn app, then continue.");
        setStage("approve");
      } else {
        if (stage === "code") setError("That code was not accepted. Check it and try again.");
        setStage("code");
        setCode("");
        setTimeout(() => codeRef.current?.focus(), 0);
      }
      return;
    }
    backToForm(result.message ?? "The sign-in did not go through.");
  }

  /** Create the account row the first time through; a retry reuses it (an email can only be added once). */
  async function ensureAccount(): Promise<string> {
    if (accountId) return accountId;
    const created = await api<{ id: string }>("/api/accounts", { method: "POST", body: { name: name.trim(), email: email.trim(), timezone } });
    setAccountId(created.id);
    const extra: Record<string, unknown> = {};
    if (ownerId && ownerId !== session?.user?.id) extra.owner_id = ownerId;
    if (proxy.url.trim()) {
      extra.proxy_url = proxy.url.trim();
      if (proxy.username.trim()) extra.proxy_username = proxy.username.trim();
      if (proxy.password) extra.proxy_password = proxy.password;
      if (proxy.label.trim()) extra.proxy_label = proxy.label.trim();
    }
    try {
      if (Object.keys(extra).length > 0) await api(`/api/accounts/${created.id}`, { method: "PUT", body: extra });
    } finally {
      onChanged();
    }
    return created.id;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy("submit");
    setError(null);
    try {
      if (stage === "code") {
        takeResult(await api<LoginResult>(`/api/accounts/${accountId}/login`, { method: "POST", body: { step: "verify", code: code.trim() } }));
      } else if (stage === "approve") {
        takeResult(await api<LoginResult>(`/api/accounts/${accountId}/login`, { method: "POST", body: { step: "await" } }));
      } else {
        const id = await ensureAccount();
        if (method === "login") {
          takeResult(await api<LoginResult>(`/api/accounts/${id}/login`, { method: "POST", body: { step: "start", email: email.trim(), password } }));
        } else {
          const saved = await api<{ verified: boolean; detail?: string }>(`/api/accounts/${id}/authenticate`, { method: "POST", body: { li_at: cookie.trim(), document_cookie: extraCookies.trim() || undefined } });
          if (saved.verified) toast.success(`${name || account?.name || "The account"} is signed in to LinkedIn`);
          else toast.warning("The session was saved but could not be checked", { description: saved.detail ?? "It will be checked the first time it is used." });
          onChanged();
          onDone();
        }
      }
    } catch (cause) {
      setError(errorMessage(cause));
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function resend() {
    if (busy || !accountId) return;
    setBusy("resend");
    try {
      const result = await api<LoginResult>(`/api/accounts/${accountId}/login`, { method: "POST", body: { step: "resend" } });
      if (result.status === "challenge") {
        setChallenge({ message: result.message ?? "", expiresAt: result.expires_at ? Date.parse(result.expires_at) : null, resendAt: Date.now() + RESEND_AFTER_MS });
        setError(null);
      } else {
        backToForm(result.message ?? "The sign-in is no longer being held. Start again.");
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  const formReady = email.trim() !== "" && (reconnecting || name.trim() !== "") && (method === "login" ? password !== "" : cookie.trim() !== "");
  const proxyNote = account?.proxy ? `through the proxy ${account.proxy.label || hostOf(account.proxy.server)}` : proxy.url.trim() ? "through the proxy below" : "from this server";

  return (
    <Card className="flex min-h-0 flex-col overflow-hidden" id="connect-panel">
      <div className="flex items-center justify-between gap-2.5 border-b border-line px-3.5 py-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="truncate text-125 font-semibold text-ink">{reconnecting ? `Sign ${account.name} in again` : "Connect a new account"}</h2>
          <p className="truncate text-11 text-ink-2">{reconnecting ? account.email : "It starts from the workspace's limit preset"}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {stage !== "form" ? <Pill tone="brand" dot className="h-[19px] text-10">In progress</Pill> : null}
          {reconnecting ? <IconButton icon={X} label="Stop signing this account in again" size={24} onClick={onCancel} /> : null}
        </div>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-2.5 p-3.5">
        <fieldset disabled={stage !== "form" || busy !== null} className="flex min-w-0 flex-col gap-2.5 disabled:opacity-60">
          <Eyebrow>Connection method</Eyebrow>
          <div role="radiogroup" aria-label="Connection method" className="flex flex-col gap-2.5">
            <MethodOption
              selected={method === "login"} onSelect={() => setMethod("login")} icon={Server} title="Server login" badge="Recommended"
              description={`Linki signs in ${proxyNote}. Handles verification codes and app approvals.`}
            />
            <MethodOption
              selected={method === "cookie"} onSelect={() => setMethod("cookie")} icon={Cookie} title="Cookie paste"
              description="Paste the li_at cookie from a browser where the account is signed in. No password is entered here."
            />
          </div>

          <div className="h-px w-full bg-line" />

          {!reconnecting ? (
            <Field label="Name">
              {(id) => <Input id={id} icon={User} value={name} onChange={(event) => setName(event.target.value)} placeholder="Whose LinkedIn account this is" autoComplete="off" required />}
            </Field>
          ) : null}
          <Field label="LinkedIn email">
            {(id) => <Input id={id} icon={Mail} type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@company.com" autoComplete="off" disabled={accountId !== null} required />}
          </Field>
          {method === "login" ? (
            <Field label="Password" hint="Used once to sign in. It is not stored.">
              {(id) => <Input id={id} icon={Lock} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required />}
            </Field>
          ) : (
            <>
              <Field label="li_at cookie" hint="In the signed-in browser: developer tools → Application → Cookies → linkedin.com → li_at.">
                {(id) => <Input id={id} icon={KeyRound} value={cookie} onChange={(event) => setCookie(event.target.value)} autoComplete="off" spellCheck={false} className="font-mono" required />}
              </Field>
              <Field label="Other cookies (optional)" hint="The output of document.cookie on linkedin.com. Sales Navigator needs these.">
                {(id) => <Textarea id={id} value={extraCookies} onChange={(event) => setExtraCookies(event.target.value)} rows={2} spellCheck={false} className="font-mono" />}
              </Field>
            </>
          )}

          {!reconnecting ? (
            <>
              <Field label="Account owner">
                {(id) => (
                  <Select
                    id={id} className="w-full" icon={User} value={ownerId || undefined} onChange={setOwnerId} placeholder="Choose a member"
                    options={members.map((member) => ({ value: member.id, label: member.name }))}
                  />
                )}
              </Field>
              <div className="flex flex-col gap-2.5">
                <button
                  type="button" aria-expanded={showProxy} onClick={() => setShowProxy((open) => !open)}
                  className="inline-flex items-center gap-1.5 self-start text-105 font-semibold text-ink-2 hover:text-ink"
                >
                  <Network size={13} aria-hidden="true" />
                  Proxy{proxy.url.trim() ? ` · ${proxy.label.trim() || proxy.url.trim()}` : " (optional)"}
                  <ChevronDown size={12} className={cn("transition-transform", showProxy && "rotate-180")} aria-hidden="true" />
                </button>
                {showProxy ? (
                  <div className="flex flex-col gap-2.5 rounded-md bg-subtle p-2.5">
                    <Field label="Proxy address" hint="One you supply. The account signs in, and is always used, through it.">
                      {(id) => <Input id={id} value={proxy.url} onChange={(event) => setProxy({ ...proxy, url: event.target.value })} placeholder="http://host:port" autoComplete="off" spellCheck={false} />}
                    </Field>
                    <div className="grid grid-cols-2 gap-2.5">
                      <Field label="User name">
                        {(id) => <Input id={id} value={proxy.username} onChange={(event) => setProxy({ ...proxy, username: event.target.value })} autoComplete="off" />}
                      </Field>
                      <Field label="Password">
                        {(id) => <Input id={id} type="password" value={proxy.password} onChange={(event) => setProxy({ ...proxy, password: event.target.value })} autoComplete="new-password" />}
                      </Field>
                    </div>
                    <Field label="Label" hint="Shown on the account, for example a city.">
                      {(id) => <Input id={id} value={proxy.label} onChange={(event) => setProxy({ ...proxy, label: event.target.value })} placeholder="Frankfurt" maxLength={80} />}
                    </Field>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </fieldset>

        {stage === "code" && challenge ? (
          <ChallengeBox
            icon={ShieldCheck} title="Verification required" timer={challenge.expiresAt ? (expired ? "expired" : `session held ${countdown(challenge.expiresAt, now)}`) : null}
            message={expired ? "The sign-in was held too long and has been dropped. Start again." : challenge.message || "LinkedIn sent a code to the account's email or phone. Enter it here."}
            note={expired ? null : "Do not open LinkedIn in another browser while the sign-in is being held."}
          >
            {expired ? (
              <Button variant="secondary" className="h-[30px] w-full" onClick={() => backToForm(null)}>Start again</Button>
            ) : (
              <>
                <CodeBoxes ref={codeRef} value={code} onChange={(next) => { setCode(next); setError(null); }} disabled={busy !== null} />
                <div className="flex gap-2">
                  <Button variant="secondary" className="h-[30px] flex-1" loading={busy === "resend"} disabled={busy !== null || now < challenge.resendAt} onClick={resend}>
                    {now < challenge.resendAt ? `Resend in ${countdown(challenge.resendAt, now)}` : "Resend code"}
                  </Button>
                  <Button type="submit" variant="primary" className="h-[30px] flex-1" loading={busy === "submit"} disabled={busy !== null || code.trim().length < 4}>
                    Verify &amp; connect
                  </Button>
                </div>
              </>
            )}
          </ChallengeBox>
        ) : null}

        {stage === "approve" && challenge ? (
          <ChallengeBox
            icon={Smartphone} title="Approve in the LinkedIn app" timer={challenge.expiresAt ? (expired ? "expired" : `session held ${countdown(challenge.expiresAt, now)}`) : null}
            message={expired ? "The sign-in was held too long and has been dropped. Start again." : challenge.message || "LinkedIn sent a sign-in request to the account's phone. Approve it there, then continue."}
            note={null}
          >
            {expired ? (
              <Button variant="secondary" className="h-[30px] w-full" onClick={() => backToForm(null)}>Start again</Button>
            ) : (
              <div className="flex gap-2">
                <Button variant="secondary" className="h-[30px] flex-1" disabled={busy !== null} onClick={() => backToForm(null)}>Cancel</Button>
                <Button type="submit" variant="primary" className="h-[30px] flex-1" loading={busy === "submit"}>I have approved it</Button>
              </div>
            )}
          </ChallengeBox>
        ) : null}

        {error ? <Alert tone="bad">{error}</Alert> : null}

        {stage === "form" ? (
          <Button type="submit" variant="primary" loading={busy === "submit"} disabled={!formReady} className="w-full">
            {method === "login" ? "Sign in to LinkedIn" : "Save and check the session"}
          </Button>
        ) : null}

        {!reconnecting ? (
          <>
            <div className="h-px w-full bg-line" />
            <Eyebrow>Safety defaults for this account</Eyebrow>
            <ul className="flex flex-col gap-2.5">
              {presetLines(preset, timezone).map((line, index) => {
                const LineIcon = [TrendingUp, CalendarClock, Undo2][index];
                return (
                  <li key={line} className="flex items-start gap-2 text-11 text-ink-2">
                    <LineIcon size={13} className="mt-px shrink-0 text-ink-3" aria-hidden="true" />
                    <span className="min-w-0 flex-1">{line}</span>
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
      </form>

      <div className="mt-auto flex h-11 shrink-0 items-center justify-between gap-2 border-t border-line bg-subtle px-3.5">
        <span className="truncate text-105 text-ink-3">Never shared with other workspaces</span>
        <Popover align="end" side="top" className="w-[300px]" trigger={<TextAction>Security details</TextAction>}>
          <div className="flex flex-col gap-2 p-1 text-11 leading-4 text-ink-2">
            <p className="text-12 font-semibold text-ink">What is kept, and where</p>
            <p>A LinkedIn password is used once, to sign in on this server, and is not stored.</p>
            <p>The session LinkedIn issues is stored encrypted in this instance&rsquo;s database, with the browser settings it was created under, and is used only for this workspace.</p>
            <p>A proxy password is stored encrypted and is never shown again.</p>
            <p>Disconnecting an account deletes its stored session.</p>
          </div>
        </Popover>
      </div>
    </Card>
  );
}

function MethodOption({ selected, onSelect, icon: IconGlyph, title, badge, description }: { selected: boolean; onSelect: () => void; icon: Icon; title: string; badge?: string; description: string }) {
  return (
    <button
      type="button" role="radio" aria-checked={selected} onClick={onSelect}
      className={cn("flex w-full items-start gap-[9px] rounded-lg border p-2.5 text-left transition-colors", selected ? "border-brand bg-brand-tint" : "border-line bg-subtle hover:border-line-strong")}
    >
      <span className={cn("mt-px inline-flex size-4 shrink-0 items-center justify-center rounded-full border", selected ? "border-brand bg-brand" : "border-line-strong bg-surface shadow-card")} aria-hidden="true">
        {selected ? <span className="size-1.5 rounded-full bg-white" /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex items-center gap-[7px]">
          <IconGlyph size={13} className="shrink-0 text-ink-2" aria-hidden="true" />
          <span className="text-12 font-semibold text-ink">{title}</span>
          {badge ? <span className="inline-flex h-[17px] items-center rounded-full bg-surface px-2 text-95 font-semibold text-brand-strong shadow-card">{badge}</span> : null}
        </span>
        <span className="text-105 leading-[15px] text-ink-2">{description}</span>
      </span>
    </button>
  );
}

function ChallengeBox({ icon: IconGlyph, title, timer, message, note, children }: { icon: Icon; title: string; timer: string | null; message: string; note: string | null; children: ReactNode }) {
  return (
    <div role="group" aria-label={title} className="flex flex-col gap-2.5 rounded-[9px] bg-warn-tint p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-[7px] text-12 font-semibold text-ink">
          <IconGlyph size={14} className="text-warn" aria-hidden="true" />
          {title}
        </span>
        {timer ? <span className="font-mono text-105 font-medium text-warn" aria-live="off">{timer}</span> : null}
      </div>
      <p className="text-11 leading-4 text-ink-2" aria-live="polite">
        {message}
        {note ? ` ${note}` : ""}
      </p>
      {children}
    </div>
  );
}

/**
 * Six boxes that are really one input: typing, pasting, backspace and autofill all
 * behave as they do in any text field, and a screen reader meets a single control.
 */
function CodeBoxes({ value, onChange, disabled, ref }: { value: string; onChange: (value: string) => void; disabled?: boolean; ref: React.Ref<HTMLInputElement> }) {
  const [focused, setFocused] = useState(false);
  const digits = value.slice(0, CODE_LENGTH).split("");
  return (
    <div className="relative">
      <div className="flex gap-1.5" aria-hidden="true">
        {Array.from({ length: CODE_LENGTH }, (_, index) => {
          const active = focused && index === Math.min(digits.length, CODE_LENGTH - 1);
          return (
            <span key={index} className={cn("flex h-[38px] flex-1 items-center justify-center rounded-md border bg-surface font-mono text-15 font-semibold text-ink", active ? "border-brand ring-1 ring-brand" : "border-line-strong")}>
              {digits[index] ?? (active ? <span className="h-[17px] w-[1.5px] animate-pulse bg-brand" /> : null)}
            </span>
          );
        })}
      </div>
      <input
        ref={ref} value={value} disabled={disabled} inputMode="numeric" autoComplete="one-time-code" aria-label="Verification code" maxLength={CODE_LENGTH}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH))}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        className="absolute inset-0 size-full cursor-text opacity-0"
      />
    </div>
  );
}
