import Head from "next/head";
import Image from "next/image";
import Link from "next/link";
import { signIn, useSession } from "next-auth/react";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { RiArrowRightLine } from "react-icons/ri";

type Invite = { email:string; role:string; workspace_id:string; workspace_name:string; status:string; expires_at:string; existing_user:boolean };

export default function InvitationPage() {
  const router = useRouter();
  const token = typeof router.query.token === "string" ? router.query.token : "";
  const { data: session, update } = useSession();
  const [invite,setInvite]=useState<Invite|null>(null);
  const [password,setPassword]=useState("");
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  useEffect(()=>{if(!token)return;fetch(`/api/invitations/${encodeURIComponent(token)}`).then(async r=>{const b=await r.json();if(!r.ok)throw new Error(b.error);return b;}).then(setInvite).catch(e=>setError(e.message));},[token]);

  async function accept() {
    setBusy(true);setError("");
    try {
      const response=await fetch(`/api/invitations/${encodeURIComponent(token)}`,{method:"POST"});const body=await response.json();if(!response.ok)throw new Error(body.error);
      await update({workspaceId:body.workspace_id});await router.replace("/platform");
    } catch(e){setError(e instanceof Error?e.message:String(e));setBusy(false);}
  }
  async function createAccount(e:React.FormEvent){e.preventDefault();if(!invite)return;setBusy(true);setError("");
    const response=await fetch("/api/auth/signup",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:invite.email,password,invite_token:token})});const body=await response.json();
    if(!response.ok){setError(body.error??"Unable to create account");setBusy(false);return;}
    const login=await signIn("credentials",{email:invite.email,password,redirect:false});if(!login?.ok){setError("Account created, but sign-in failed.");setBusy(false);return;}await update({workspaceId:invite.workspace_id});await router.replace("/platform");
  }
  const callback=`/invite/${encodeURIComponent(token)}`;
  return <><Head><title>Workspace invitation — Linki</title><meta name="robots" content="noindex,nofollow"/></Head>
    <main className="flex min-h-screen items-center justify-center bg-base-200 px-5 py-10 sm:px-8">
      <div className="w-full max-w-[420px]">
        <div className="mb-8 flex justify-center">
          <Image src="/linki-wordmark.svg" alt="Linki" width={104} height={30} priority />
        </div>
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-base-100 p-6 shadow-[var(--shadow-raised)] sm:p-8">
          <div className="mb-6">
            <p className="mb-2 text-xs font-semibold text-primary">You've been invited</p>
            <h1 className="text-[30px] font-semibold leading-[1.1] tracking-[-.03em] text-base-content">
              Join {invite?.workspace_name??"workspace"}
            </h1>
            {invite&&<p className="mt-3 text-[15px] leading-6 text-base-content/50">You were invited as <strong className="font-medium text-base-content/75">{invite.role}</strong> using {invite.email}.</p>}
          </div>

          {!invite&&!error&&<div className="flex justify-center py-4"><span className="loading loading-spinner loading-sm text-base-content/40"/></div>}

          {invite?.status!=="pending"&&invite&&<div role="alert" className="rounded-[10px] border border-[var(--warning-border)] bg-[var(--warning-bg)] px-3.5 py-3 text-sm text-[var(--warning-text)]">This invitation is {invite.status}.</div>}

          {invite?.status==="pending"&&session?.user&&<button className="btn btn-primary h-11 w-full justify-between px-4" disabled={busy} onClick={()=>void accept()}><span>{busy?"Joining…":"Accept invitation"}</span>{busy?<span className="loading loading-spinner loading-xs"/>:<RiArrowRightLine size={17}/>}</button>}

          {invite?.status==="pending"&&!session&&invite.existing_user&&<Link className="btn btn-primary h-11 w-full justify-between px-4" href={`/login?callbackUrl=${encodeURIComponent(callback)}`}><span>Sign in to accept</span><RiArrowRightLine size={17}/></Link>}

          {invite?.status==="pending"&&!session&&!invite.existing_user&&<form className="flex flex-col gap-4" onSubmit={createAccount}>
            <div className="flex flex-col gap-2">
              <label htmlFor="invite-email" className="text-xs font-medium text-base-content/75">Work email</label>
              <input id="invite-email" className="input h-11 w-full text-sm" value={invite.email} disabled/>
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="invite-password" className="text-xs font-medium text-base-content/75">Password</label>
              <input id="invite-password" className="input h-11 w-full text-sm" type="password" minLength={8} required placeholder="At least 8 characters" value={password} onChange={e=>setPassword(e.target.value)}/>
            </div>
            <button className="btn btn-primary mt-1 h-11 w-full justify-between px-4" disabled={busy}><span>{busy?"Creating…":"Create account and join"}</span>{busy?<span className="loading loading-spinner loading-xs"/>:<RiArrowRightLine size={17}/>}</button>
          </form>}

          {error&&<p role="alert" className="mt-4 rounded-[10px] border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3.5 py-3 text-xs text-[var(--danger-text)]">{error}</p>}
        </div>
        <p className="mt-7 text-center text-[11px] leading-5 text-base-content/45">
          Joining a workspace shares your name and email with its members.
        </p>
      </div>
    </main>
  </>;
}
