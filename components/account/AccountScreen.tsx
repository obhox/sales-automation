import { useState } from "react";
import { signOut } from "next-auth/react";
import { useSWRConfig } from "swr";
import { KeyRound, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Page } from "@/components/shell";
import { Avatar, Button, Card, ErrorState, Field, Input, Pill, Skeleton } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { formatDate } from "@/lib/client/format";
import { ROLE_LABEL } from "@/lib/roles";
import type { AccountPayload } from "@/pages/api/account";

const MAX_NAME = 80;
const MIN_PASSWORD = 8;

/** A member's own account: the name others see, and their password. */
export function AccountScreen() {
  const { data, error, isLoading, mutate } = useApi<AccountPayload>("/api/account");
  return (
    <Page title="Your account" meta={data ? <span className="text-11 text-ink-3">{data.email}</span> : null}>
      {error && !data ? (
        <Card><ErrorState message={errorMessage(error)} onRetry={() => void mutate()} /></Card>
      ) : isLoading || !data ? (
        <div className="flex max-w-[1040px] flex-col gap-3.5 lg:flex-row lg:items-start" aria-busy="true" aria-label="Loading your account">
          <div className="flex min-w-0 flex-1 flex-col gap-3.5">
            <Skeleton className="h-[230px] rounded-lg" />
            <Skeleton className="h-[300px] rounded-lg" />
          </div>
          <Skeleton className="h-[200px] w-full rounded-lg lg:w-[368px]" />
        </div>
      ) : (
        <div className="flex max-w-[1040px] flex-col gap-3.5 lg:flex-row lg:items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-3.5">
            {/* Keyed by what is saved, so the form starts again from it after a save. */}
            <ProfileCard key={data.name} account={data} onSaved={(next) => void mutate(next, { revalidate: false })} />
            <PasswordCard />
          </div>
          <Card className="flex w-full shrink-0 flex-col gap-[11px] p-3.5 lg:w-[368px]">
            <div className="flex flex-col gap-0.5">
              <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">Your workspaces</h2>
              <p className="text-11 text-ink-3">Your role is set separately in each</p>
            </div>
            <ul className="flex flex-col gap-[7px]">
              {[...data.workspaces].sort((a, b) => Number(b.current) - Number(a.current)).map((workspace) => (
                <li key={workspace.id} className={`flex items-center justify-between gap-2.5 rounded-lg p-[9px] ${workspace.current ? "bg-brand-tint" : "bg-subtle"}`}>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-12 font-semibold text-ink">{workspace.name}</span>
                    <span className="text-105 text-ink-3">{workspace.current ? "The workspace you are in" : "Switch to it from the top of the sidebar"}</span>
                  </span>
                  {workspace.suspended ? <Pill tone="bad">Access suspended</Pill> : <Pill tone={workspace.current ? "brand" : "neutral"}>{ROLE_LABEL[workspace.role]}</Pill>}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </Page>
  );
}

function ProfileCard({ account, onSaved }: { account: AccountPayload; onSaved: (account: AccountPayload) => void }) {
  const { mutate: mutateAny } = useSWRConfig();
  const [name, setName] = useState(account.name);
  const [saving, setSaving] = useState(false);
  const changed = name.trim().replace(/\s+/g, " ") !== account.name;

  async function save() {
    setSaving(true);
    try {
      const saved = await api<AccountPayload>("/api/account", { method: "PUT", body: { name } });
      toast.success(saved.name ? `You are shown as ${saved.name}` : "Your name was cleared", { description: saved.name ? undefined : `You are shown as ${saved.shown_as}.` });
      onSaved(saved);
      // The sidebar shows the name too.
      void mutateAny("/api/shell");
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3.5 p-4">
      <div className="flex items-center gap-[11px]">
        <span className="inline-flex size-[34px] shrink-0 items-center justify-center rounded-[9px] bg-brand-tint text-brand" aria-hidden="true"><UserRound size={17} /></span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">Profile</h2>
          <p className="text-11 text-ink-3">How you appear to the people you work with</p>
        </div>
      </div>
      <form
        className="grid grid-cols-1 gap-3.5 md:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (changed && !saving) void save();
        }}
      >
        <Field label="Name" hint={name.trim() ? "Shown on your campaigns, replies, tasks and in the audit log." : `With no name you are shown as ${account.shown_as}.`} aside={`${name.length} / ${MAX_NAME}`}>
          {(id) => <Input id={id} value={name} maxLength={MAX_NAME} autoComplete="name" placeholder={account.shown_as} onChange={(event) => setName(event.target.value)} trailing={<Avatar name={name.trim() || account.shown_as} size={22} />} />}
        </Field>
        <Field label="Email address" hint={`${account.email_verified ? "Confirmed. " : ""}You sign in with this address. It cannot be changed here.`}>
          {(id) => <Input id={id} value={account.email} readOnly className="text-ink-2" />}
        </Field>
        <div className="flex items-center justify-between gap-3 md:col-span-2">
          <span className="text-105 text-ink-3">{account.created_at ? `Account created ${formatDate(account.created_at)}` : ""}</span>
          <Button type="submit" variant="primary" loading={saving} disabled={!changed}>Save name</Button>
        </div>
      </form>
    </Card>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [saving, setSaving] = useState(false);
  const [tried, setTried] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const tooShort = next.length > 0 && next.length < MIN_PASSWORD;
  const mismatch = again.length > 0 && next !== again;
  const same = next.length >= MIN_PASSWORD && next === current;

  async function change() {
    setTried(true);
    setRefused(null);
    if (!current || next.length < MIN_PASSWORD || next !== again || same) return;
    setSaving(true);
    try {
      await api("/api/auth/change-password", { method: "POST", body: { currentPassword: current, newPassword: next } });
      // Changing the password ends every session, this one included.
      await signOut({ callbackUrl: "/login?notice=password-changed" });
    } catch (cause) {
      setRefused(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3.5 p-4">
      <div className="flex items-center gap-[11px]">
        <span className="inline-flex size-[34px] shrink-0 items-center justify-center rounded-[9px] bg-subtle text-ink-2" aria-hidden="true"><KeyRound size={16} /></span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">Password</h2>
          <p className="text-11 text-ink-3">Changing it signs you out everywhere, this browser included</p>
        </div>
      </div>
      <form
        className="grid grid-cols-1 gap-3.5 md:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!saving) void change();
        }}
      >
        <Field label="Current password" error={refused ?? (tried && !current ? "Enter the password you sign in with now." : undefined)} className="md:col-span-2 md:max-w-[calc(50%-7px)]">
          {(id) => <Input id={id} type="password" autoComplete="current-password" value={current} invalid={Boolean(refused) || (tried && !current)} onChange={(event) => { setCurrent(event.target.value); setRefused(null); }} />}
        </Field>
        <Field label="New password" error={tooShort || (tried && !next) ? `At least ${MIN_PASSWORD} characters.` : same ? "Choose a password different from the current one." : undefined} hint={`At least ${MIN_PASSWORD} characters.`}>
          {(id) => <Input id={id} type="password" autoComplete="new-password" value={next} invalid={tooShort || same || (tried && !next)} onChange={(event) => setNext(event.target.value)} />}
        </Field>
        <Field label="New password again" error={mismatch ? "The two do not match." : tried && !again ? "Type the new password once more." : undefined}>
          {(id) => <Input id={id} type="password" autoComplete="new-password" value={again} invalid={mismatch || (tried && !again)} onChange={(event) => setAgain(event.target.value)} />}
        </Field>
        <div className="flex items-center justify-between gap-3 md:col-span-2">
          <span className="text-105 text-ink-3">You will be asked to sign in again with the new password.</span>
          <Button type="submit" variant="primary" loading={saving}>Change password</Button>
        </div>
      </form>
    </Card>
  );
}
