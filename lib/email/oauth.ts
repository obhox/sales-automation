import { randomBytes, randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import type { SendReceipt } from "@/lib/email/sender";

export type MailOAuthProvider = "gmail" | "microsoft";
type Connection = { id:string;workspace_id:string;provider:MailOAuthProvider;email:string;access_token:string;refresh_token:string|null;expires_at:string|null };

export function mailOAuthAuthorizationUrl(input:{provider:MailOAuthProvider;workspaceId:string;userId:string;origin:string;redirectAfter?:string}){
  const clientId=client(input.provider).id;const state=randomBytes(32).toString("base64url");
  getDb().prepare("INSERT INTO mail_oauth_states(state_hash,workspace_id,user_id,provider,redirect_after,expires_at) VALUES(?,?,?,?,?,?)")
    .run(hash(state),input.workspaceId,input.userId,input.provider,input.redirectAfter??"/platform",new Date(Date.now()+10*60_000).toISOString());
  const redirect=`${input.origin}/api/mail/oauth/${input.provider}/callback`;
  const url=input.provider==="gmail"?new URL("https://accounts.google.com/o/oauth2/v2/auth"):new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  url.searchParams.set("client_id",clientId);url.searchParams.set("redirect_uri",redirect);url.searchParams.set("response_type","code");url.searchParams.set("state",state);
  if(input.provider==="gmail") {url.searchParams.set("access_type","offline");url.searchParams.set("prompt","consent");url.searchParams.set("include_granted_scopes","true");url.searchParams.set("scope","openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify");}
  else {url.searchParams.set("response_mode","query");url.searchParams.set("scope","openid profile email offline_access Mail.ReadWrite Mail.Send");}
  return url.toString();
}

export async function completeMailOAuth(input:{provider:MailOAuthProvider;state:string;code:string;origin:string}){
  const db=getDb();const row=db.prepare("SELECT * FROM mail_oauth_states WHERE state_hash=? AND provider=? AND expires_at>datetime('now')").get(hash(input.state),input.provider) as {workspace_id:string;user_id:string;redirect_after:string}|undefined;
  if(!row)throw new Error("OAuth state is invalid or expired");db.prepare("DELETE FROM mail_oauth_states WHERE state_hash=?").run(hash(input.state));
  const cfg=client(input.provider);const redirect=`${input.origin}/api/mail/oauth/${input.provider}/callback`;
  const body=new URLSearchParams({client_id:cfg.id,client_secret:cfg.secret,code:input.code,redirect_uri:redirect,grant_type:"authorization_code"});
  const tokenUrl=input.provider==="gmail"?"https://oauth2.googleapis.com/token":"https://login.microsoftonline.com/common/oauth2/v2.0/token";
  if(input.provider==="microsoft")body.set("scope","openid profile email offline_access Mail.ReadWrite Mail.Send");
  const token=await jsonFetch(tokenUrl,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body});
  const access=String(token.access_token??"");if(!access)throw new Error("Provider did not return an access token");
  const profile=input.provider==="gmail"?await jsonFetch("https://gmail.googleapis.com/gmail/v1/users/me/profile",{headers:{authorization:`Bearer ${access}`}}):await jsonFetch("https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName",{headers:{authorization:`Bearer ${access}`}});
  const email=String(profile.emailAddress??profile.mail??profile.userPrincipalName??"").toLowerCase();if(!email)throw new Error("Provider account has no email address");
  const expiresAt=new Date(Date.now()+Number(token.expires_in??3600)*1000).toISOString();const id=randomUUID();
  db.prepare(`INSERT INTO mail_provider_connections(id,workspace_id,provider,email,access_token,refresh_token,expires_at,scopes,provider_account_id,created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,provider,email) DO UPDATE SET access_token=excluded.access_token,
    refresh_token=COALESCE(excluded.refresh_token,mail_provider_connections.refresh_token),expires_at=excluded.expires_at,scopes=excluded.scopes,
    provider_account_id=excluded.provider_account_id,enabled=1,last_error=NULL,updated_at=datetime('now')`)
    .run(id,row.workspace_id,input.provider,email,encryptSecret(access),token.refresh_token?encryptSecret(String(token.refresh_token)):null,expiresAt,String(token.scope??""),String(profile.id??email),row.user_id);
  const connection=db.prepare("SELECT id FROM mail_provider_connections WHERE workspace_id=? AND provider=? AND email=?").get(row.workspace_id,input.provider,email) as {id:string};
  const existing=db.prepare("SELECT id FROM email_accounts WHERE workspace_id=? AND provider=? AND lower(from_email)=?").get(row.workspace_id,input.provider,email) as {id:string}|undefined;
  const accountId=existing?.id??randomUUID();
  if(existing)db.prepare("UPDATE email_accounts SET oauth_connection_id=?,is_verified=1,paused_at=NULL,paused_reason=NULL WHERE id=?").run(connection.id,accountId);
  else db.prepare(`INSERT INTO email_accounts(id,workspace_id,name,from_email,smtp_host,username,password,provider,oauth_connection_id,is_verified)
    VALUES(?,?,?,?,?,?,?,?,?,1)`).run(accountId,row.workspace_id,`${input.provider==="gmail"?"Gmail":"Microsoft"} — ${email}`,email,"oauth.provider.invalid",email,encryptSecret("oauth-managed"),input.provider,connection.id);
  await provisionMailboxWatch(connection.id,input.origin).catch(error=>db.prepare("UPDATE mail_provider_connections SET last_error=? WHERE id=?").run(message(error),connection.id));
  return {workspaceId:row.workspace_id,connectionId:connection.id,emailAccountId:accountId,email,redirectAfter:row.redirect_after};
}

export async function sendOAuthEmail(input:{connectionId:string;fromName?:string|null;to:string;subject:string;body:string;html?:string;messageId:string;headers?:Record<string,string>}):Promise<SendReceipt>{
  const connection=getConnection(input.connectionId);const token=await validAccessToken(connection);
  if(connection.provider==="gmail"){
    const from=input.fromName?`"${input.fromName.replaceAll('"','')}" <${connection.email}>`:connection.email;
    const boundary=`linki-${input.messageId.replace(/[^a-z0-9]/gi,"").slice(0,32)}`;
    const headers={From:from,To:input.to,Subject:input.subject,"Message-ID":input.messageId,"MIME-Version":"1.0","Content-Type":input.html?`multipart/alternative; boundary="${boundary}"`:"text/plain; charset=utf-8",...(input.headers??{})};
    const content=input.html
      ? `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${input.body}\r\n--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${input.html}\r\n--${boundary}--`
      : input.body;
    const raw=Object.entries(headers).map(([k,v])=>`${k}: ${v}`).join("\r\n")+`\r\n\r\n${content}`;
    const result=await jsonFetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send",{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({raw:Buffer.from(raw).toString("base64url")})});
    return {messageId:input.messageId,providerMessageId:String(result.id??""),response:"Gmail API accepted"};
  }
  const draft=await jsonFetch("https://graph.microsoft.com/v1.0/me/messages",{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({subject:input.subject,body:{contentType:input.html?"HTML":"Text",content:input.html??input.body},toRecipients:[{emailAddress:{address:input.to}}],internetMessageHeaders:[{name:"x-linki-message-id",value:input.messageId},...Object.entries(input.headers??{}).map(([name,value])=>({name,value}))]})});
  const providerId=String(draft.id??"");if(!providerId)throw new Error("Microsoft Graph did not create a draft");
  const response=await fetch(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(providerId)}/send`,{method:"POST",headers:{authorization:`Bearer ${token}`}});if(!response.ok)throw new Error(`Microsoft send failed (${response.status}): ${(await response.text()).slice(0,500)}`);
  return {messageId:input.messageId,providerMessageId:providerId,response:"Microsoft Graph accepted"};
}

export async function provisionMailboxWatch(connectionId:string,origin:string){
  const c=getConnection(connectionId);const access=await validAccessToken(c);const db=getDb();
  if(c.provider==="gmail"){
    const topic=process.env.GMAIL_PUBSUB_TOPIC;if(!topic)return {configured:false,reason:"GMAIL_PUBSUB_TOPIC is not set"};
    const out=await jsonFetch("https://gmail.googleapis.com/gmail/v1/users/me/watch",{method:"POST",headers:{authorization:`Bearer ${access}`,"content-type":"application/json"},body:JSON.stringify({topicName:topic,labelIds:["INBOX"],labelFilterBehavior:"INCLUDE"})});
    db.prepare("UPDATE mail_provider_connections SET watch_id=?,watch_expires_at=?,updated_at=datetime('now') WHERE id=?").run(String(out.historyId??""),new Date(Number(out.expiration)).toISOString(),connectionId);return {configured:true};
  }
  const clientState=randomBytes(24).toString("base64url");const expiration=new Date(Date.now()+2.5*24*3600_000).toISOString();
  const out=await jsonFetch("https://graph.microsoft.com/v1.0/subscriptions",{method:"POST",headers:{authorization:`Bearer ${access}`,"content-type":"application/json"},body:JSON.stringify({changeType:"created",notificationUrl:`${origin}/api/providers/webhooks/microsoft/${c.workspace_id}`,lifecycleNotificationUrl:`${origin}/api/providers/webhooks/microsoft/${c.workspace_id}`,resource:"me/mailFolders('Inbox')/messages",expirationDateTime:expiration,clientState})});
  db.prepare("UPDATE mail_provider_connections SET watch_id=?,watch_expires_at=?,client_state=?,updated_at=datetime('now') WHERE id=?").run(String(out.id??""),expiration,encryptSecret(clientState),connectionId);return {configured:true};
}

export async function validAccessToken(c:Connection){
  if(c.expires_at&&Date.parse(c.expires_at)>Date.now()+60_000)return decryptSecret(c.access_token)!;if(!c.refresh_token)throw new Error(`${c.provider} authorization expired; reconnect the mailbox`);
  const cfg=client(c.provider);const body=new URLSearchParams({client_id:cfg.id,client_secret:cfg.secret,refresh_token:decryptSecret(c.refresh_token)!,grant_type:"refresh_token"});
  if(c.provider==="microsoft")body.set("scope","openid profile email offline_access Mail.ReadWrite Mail.Send");
  const url=c.provider==="gmail"?"https://oauth2.googleapis.com/token":"https://login.microsoftonline.com/common/oauth2/v2.0/token";const token=await jsonFetch(url,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body});
  const access=String(token.access_token??"");if(!access)throw new Error("Token refresh failed");getDb().prepare("UPDATE mail_provider_connections SET access_token=?,refresh_token=COALESCE(?,refresh_token),expires_at=?,last_error=NULL,updated_at=datetime('now') WHERE id=?")
    .run(encryptSecret(access),token.refresh_token?encryptSecret(String(token.refresh_token)):null,new Date(Date.now()+Number(token.expires_in??3600)*1000).toISOString(),c.id);return access;
}

function getConnection(id:string){const c=getDb().prepare("SELECT * FROM mail_provider_connections WHERE id=? AND enabled=1").get(id) as Connection|undefined;if(!c)throw new Error("Mail OAuth connection not found");return c;}
function client(p:MailOAuthProvider){const prefix=p==="gmail"?"GOOGLE_MAIL":"MICROSOFT_MAIL";const id=process.env[`${prefix}_CLIENT_ID`];const secret=process.env[`${prefix}_CLIENT_SECRET`];if(!id||!secret)throw new Error(`${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET are required`);return{id,secret};}
function hash(v:string){return require("crypto").createHash("sha256").update(v).digest("hex");}
async function jsonFetch(url:string,init?:RequestInit):Promise<Record<string,unknown>>{const r=await fetch(url,init);const text=await r.text();let body:Record<string,unknown>={};try{body=JSON.parse(text);}catch{}if(!r.ok)throw new Error(`${url} failed (${r.status}): ${text.slice(0,500)}`);return body;}
function message(e:unknown){return e instanceof Error?e.message:String(e);}
