import Link from "next/link";
import { signIn, useSession } from "next-auth/react";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { AuthFrame, TextLink } from "@/components/auth/AuthFrame";
import { asRole, inviteProblem, type Invite } from "@/components/auth/model";
import { Alert, Button, Field, Input, Skeleton } from "@/components/ui";

/** Where the link in an invitation email lands: join the workspace, signing in or creating an account on the way. */
export default function InvitationPage() {
  const router = useRouter();
  const token = typeof router.query.token === "string" ? router.query.token : "";
  const { data: session, update } = useSession();
  const [invite, setInvite] = useState<Invite | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetch(`/api/invitations/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "This invitation could not be read.");
        setInvite(body as Invite);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "This invitation could not be read."));
  }, [token]);

  async function accept() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/invitations/${encodeURIComponent(token)}`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "The invitation could not be accepted.");
      await update({ workspaceId: body.workspace_id });
      await router.replace("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  async function createAccount(event: React.FormEvent) {
    event.preventDefault();
    if (!invite || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: invite.email, password, invite_token: token }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "The account could not be created.");
      const login = await signIn("credentials", { email: invite.email, password, redirect: false });
      if (!login?.ok) throw new Error("The account was created, but signing in failed. Sign in with the password you chose.");
      await update({ workspaceId: invite.workspace_id });
      await router.replace("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  const problem = invite ? inviteProblem(invite) : null;
  const signedInAs = session?.user?.email ?? null;
  // Signed in as someone the invitation was not sent to: accepting would be refused, so say why first.
  const wrongAccount = Boolean(invite && signedInAs && signedInAs.toLowerCase() !== invite.email.toLowerCase());

  return (
    <AuthFrame
      title="Workspace invitation"
      heading={invite ? `Join ${invite.workspace_name}` : error ? "Invitation not found" : "Workspace invitation"}
      lead={invite && !problem ? <>You were invited as {asRole(invite.role)}, using <span className="font-medium text-ink">{invite.email}</span>.</> : undefined}
      footer={invite && !problem ? "Joining a workspace shares your name and email with its members." : <TextLink href="/login">Go to sign in</TextLink>}
    >
      {!invite && !error ? <div className="flex flex-col gap-2.5"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-9 w-full" /></div> : null}
      {problem ? <Alert tone="warn">{problem}</Alert> : null}

      {invite && !problem && session?.user ? (
        wrongAccount ? (
          <Alert tone="warn" title={`You are signed in as ${signedInAs}`}>This invitation is for {invite.email}. Sign out, then open the link again and sign in with that address.</Alert>
        ) : (
          <Button variant="primary" loading={busy} onClick={() => void accept()} className="h-9 w-full">Accept invitation</Button>
        )
      ) : null}

      {invite && !problem && !session && invite.existing_user ? (
        <Button asChild variant="primary" className="h-9 w-full">
          <Link href={`/login?callbackUrl=${encodeURIComponent(`/invite/${encodeURIComponent(token)}`)}`}>Sign in to accept</Link>
        </Button>
      ) : null}

      {invite && !problem && !session && !invite.existing_user ? (
        <form onSubmit={createAccount} className="flex flex-col gap-4">
          <Field label="Work email">
            {(id) => <Input id={id} value={invite.email} disabled readOnly frameClassName="h-9" />}
          </Field>
          <Field label="Choose a password" aside="At least 8 characters">
            {(id) => <Input id={id} type="password" icon={Lock} required minLength={8} autoFocus autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} frameClassName="h-9" />}
          </Field>
          <Button type="submit" variant="primary" loading={busy} className="h-9 w-full">Create account and join</Button>
        </form>
      ) : null}

      {error ? <Alert tone="bad">{error}</Alert> : null}
    </AuthFrame>
  );
}
