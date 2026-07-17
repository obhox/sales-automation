import { randomUUID } from "crypto";
import { hostname } from "os";
import { getDb } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { sendEmail, type EmailAccount, type SendReceipt } from "@/lib/email/sender";
import { sendOAuthEmail } from "@/lib/email/oauth";
import { findTargetSuppression, isAddressSuppressed, addSuppression } from "@/lib/platform/suppression";
import { emitDomainEvent } from "@/lib/platform/events";
import { buildEmailContent, type EmailDeliveryMode } from "@/lib/email/content";

export const WORKER_ID=`${hostname()}:${process.pid}:${randomUUID().slice(0,8)}`;

export type QueueEmailInput={workspaceId:string;emailAccountId:string;idempotencyKey:string;source?:string;targetId?:string;runId?:string;stepId?:string;to:string;subject:string;body:string;deliveryMode?:EmailDeliveryMode;trackOpens?:boolean;trackClicks?:boolean;replyToMessageId?:string;headers?:Record<string,string>};
type Job={id:string;workspace_id:string;email_account_id:string;idempotency_key:string;source:string;target_id:string|null;run_id:string|null;step_id:string|null;recipient:string;subject:string;body_text:string;email_delivery_mode:EmailDeliveryMode;track_opens:number;track_clicks:number;reply_to_message_id:string|null;headers_json:string|null;status:string;attempt:number;max_attempts:number};
type Account=EmailAccount&{workspace_id:string;provider:string;oauth_connection_id:string|null;paused_at:string|null;paused_reason:string|null};
type SentRow={id:string;email_account_id:string;recipient:string;message_id:string;target_id:string|null};

export function enqueueEmail(input:QueueEmailInput){
  const db=getDb();const existing=db.prepare("SELECT id,status FROM email_jobs WHERE workspace_id=? AND idempotency_key=?").get(input.workspaceId,input.idempotencyKey) as {id:string;status:string}|undefined;if(existing)return existing;
  const id=randomUUID();db.prepare(`INSERT INTO email_jobs(id,workspace_id,email_account_id,idempotency_key,source,target_id,run_id,step_id,recipient,subject,body_text,email_delivery_mode,track_opens,track_clicks,reply_to_message_id,headers_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.workspaceId,input.emailAccountId,input.idempotencyKey,input.source??"campaign",input.targetId??null,input.runId??null,input.stepId??null,input.to.toLowerCase().trim(),input.subject,input.body,input.deliveryMode??"plain",input.trackOpens?1:0,input.trackClicks?1:0,input.replyToMessageId??null,input.headers?JSON.stringify(input.headers):null);
  return{id,status:"pending"};
}

export async function sendEmailDurably(input:QueueEmailInput):Promise<SendReceipt&{jobId:string,status:string}>{
  const queued=enqueueEmail(input);const previous=receiptForJob(queued.id);if(previous)return{...previous,jobId:queued.id,status:"sent"};
  const state=getDb().prepare("SELECT status,last_error FROM email_jobs WHERE id=?").get(queued.id) as {status:string;last_error:string|null};
  if(state.status==="uncertain")throw new Error(`Delivery is uncertain and was not retried automatically: ${state.last_error??queued.id}`);
  await dispatchEmailJob(queued.id,WORKER_ID);const receipt=receiptForJob(queued.id);if(!receipt){const final=getDb().prepare("SELECT status,last_error FROM email_jobs WHERE id=?").get(queued.id) as {status:string;last_error:string|null};throw new Error(final.last_error??`Email job ${final.status}`);}return{...receipt,jobId:queued.id,status:"sent"};
}

export async function dispatchEmailJob(jobId:string,owner=WORKER_ID){
  const db=getDb();recoverStaleEmailJobs();const leaseUntil=new Date(Date.now()+2*60_000).toISOString();
  const leased=db.prepare(`UPDATE email_jobs SET status='leased',lease_owner=?,lease_expires_at=?,updated_at=datetime('now')
    WHERE id=? AND status='pending' AND available_at<=datetime('now')`).run(owner,leaseUntil,jobId);if(!leased.changes)return;
  const job=db.prepare("SELECT * FROM email_jobs WHERE id=?").get(jobId) as Job;
  const account=db.prepare("SELECT * FROM email_accounts WHERE id=? AND workspace_id=?").get(job.email_account_id,job.workspace_id) as Account|undefined;
  try{
    if(!account)throw new SafeSendError("Sender account no longer exists");assertSenderHealthy(account);
    const suppression=job.target_id?findTargetSuppression(job.workspace_id,job.target_id):isAddressSuppressed(job.workspace_id,job.recipient);if(suppression)throw new SafeSendError(`Recipient is suppressed: ${suppression.reason}`);
    const domain=(account.from_email.split("@")[1]||"linki.local").replace(/[^a-z0-9.-]/gi,"");const messageId=`<${job.id}@${domain}>`;
    db.prepare("UPDATE email_jobs SET status='sending',attempt=attempt+1,updated_at=datetime('now') WHERE id=? AND lease_owner=?").run(job.id,owner);
    const headers={"X-Linki-Job-ID":job.id,"X-Linki-Workspace-ID":job.workspace_id,...parseHeaders(job.headers_json)};
    const content=buildEmailContent(job.body_text,{mode:job.email_delivery_mode,jobId:job.id,trackOpens:job.track_opens===1,trackClicks:job.track_clicks===1});
    const receipt=account.provider==="gmail"||account.provider==="microsoft"?await sendOAuthEmail({connectionId:String(account.oauth_connection_id),fromName:account.from_name,to:job.recipient,subject:job.subject,body:content.text,html:content.html,messageId,headers}):await sendEmail({...account,password:decryptSecret(account.password)!},job.recipient,job.subject,content.text,{messageId,headers,html:content.html});
    db.transaction(()=>{
      db.prepare(`INSERT OR IGNORE INTO sent_messages(id,workspace_id,job_id,email_account_id,target_id,run_id,recipient,subject,message_id,provider_message_id,provider,smtp_response)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),job.workspace_id,job.id,job.email_account_id,job.target_id,job.run_id,job.recipient,job.subject,receipt.messageId||messageId,receipt.providerMessageId??null,account.provider,receipt.response??null);
      db.prepare("UPDATE email_jobs SET status='sent',lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=datetime('now') WHERE id=?").run(job.id);
    })();
    emitDomainEvent({workspaceId:job.workspace_id,type:"email.sent",entityType:"sent_message",entityId:job.id,payload:{job_id:job.id,to:job.recipient,subject:job.subject,email_account_id:job.email_account_id,message_id:receipt.messageId||messageId,provider:account.provider}});
  }catch(error){
    const msg=message(error);const ambiguous=!(error instanceof SafeSendError)&&isAmbiguous(error);const current=db.prepare("SELECT attempt,max_attempts FROM email_jobs WHERE id=?").get(job.id) as {attempt:number;max_attempts:number};
    if(ambiguous)db.prepare("UPDATE email_jobs SET status='uncertain',last_error=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=datetime('now') WHERE id=?").run(msg,job.id);
    else if(current.attempt<current.max_attempts&&!(error instanceof SafeSendError))db.prepare("UPDATE email_jobs SET status='pending',last_error=?,available_at=datetime('now',?),lease_owner=NULL,lease_expires_at=NULL,updated_at=datetime('now') WHERE id=?").run(msg,`+${2**current.attempt} minutes`,job.id);
    else db.prepare("UPDATE email_jobs SET status='failed',last_error=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=datetime('now') WHERE id=?").run(msg,job.id);
    throw error;
  }
}

export async function processEmailJobs(limit=20){recoverStaleEmailJobs();const rows=getDb().prepare("SELECT id FROM email_jobs WHERE status='pending' AND available_at<=datetime('now') ORDER BY created_at LIMIT ?").all(limit) as Array<{id:string}>;let processed=0;for(const row of rows){try{await dispatchEmailJob(row.id);}catch{}processed++;}return processed;}
export function recoverStaleEmailJobs(){const db=getDb();db.prepare("UPDATE email_jobs SET status='pending',lease_owner=NULL,lease_expires_at=NULL,updated_at=datetime('now') WHERE status='leased' AND lease_expires_at<datetime('now')").run();db.prepare("UPDATE email_jobs SET status='uncertain',last_error=COALESCE(last_error,'Worker stopped during provider handoff; manual reconciliation required'),lease_owner=NULL,lease_expires_at=NULL,updated_at=datetime('now') WHERE status='sending' AND lease_expires_at<datetime('now')").run();}

export function acquireWorkerLease(name:string,owner=WORKER_ID,ttlSeconds=45){const db=getDb();const expires=new Date(Date.now()+ttlSeconds*1000).toISOString();return db.transaction(()=>{const current=db.prepare("SELECT owner_id,expires_at FROM worker_leases WHERE name=?").get(name) as {owner_id:string;expires_at:string}|undefined;if(current&&current.owner_id!==owner&&Date.parse(current.expires_at)>Date.now())return false;db.prepare(`INSERT INTO worker_leases(name,owner_id,expires_at,heartbeat_at) VALUES(?,?,?,datetime('now')) ON CONFLICT(name) DO UPDATE SET owner_id=excluded.owner_id,expires_at=excluded.expires_at,heartbeat_at=datetime('now')`).run(name,owner,expires);return true;})();}

export function recordProviderEvent(input:{workspaceId:string;provider:string;providerEventId:string;eventType:"delivered"|"bounced"|"complained"|"deferred"|"opened"|"clicked"|"unsubscribed";recipient?:string;messageId?:string;providerMessageId?:string;occurredAt?:string;payload?:unknown}){
  const db=getDb();const sent=((input.providerMessageId?db.prepare("SELECT * FROM sent_messages WHERE workspace_id=? AND provider_message_id=? ORDER BY accepted_at DESC LIMIT 1").get(input.workspaceId,input.providerMessageId):undefined)||
    (input.messageId?db.prepare("SELECT * FROM sent_messages WHERE workspace_id=? AND message_id=? ORDER BY accepted_at DESC LIMIT 1").get(input.workspaceId,input.messageId):undefined)||
    (input.recipient?db.prepare("SELECT * FROM sent_messages WHERE workspace_id=? AND lower(recipient)=lower(?) ORDER BY accepted_at DESC LIMIT 1").get(input.workspaceId,input.recipient):undefined)) as SentRow|undefined;
  if(!sent)return{matched:false,duplicate:false};const id=randomUUID();try{db.prepare(`INSERT INTO sender_events(id,workspace_id,email_account_id,sent_message_id,provider,provider_event_id,event_type,recipient,message_id,payload_json,occurred_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.workspaceId,sent.email_account_id,sent.id,input.provider,input.providerEventId,input.eventType,input.recipient??sent.recipient,input.messageId??sent.message_id,JSON.stringify(input.payload??{}),input.occurredAt??new Date().toISOString());}catch{return{matched:true,duplicate:true};}
  const field=input.eventType==="delivered"?"delivered_at":input.eventType==="bounced"?"bounced_at":input.eventType==="complained"?"complained_at":input.eventType==="deferred"?"deferred_at":null;
  if(field)db.prepare(`UPDATE sent_messages SET status=?,${field}=?,last_provider_event_at=? WHERE id=?`).run(input.eventType,input.occurredAt??new Date().toISOString(),new Date().toISOString(),sent.id);
  const recipient=String(input.recipient??sent.recipient);if(["bounced","complained","unsubscribed"].includes(input.eventType)){addSuppression({workspaceId:input.workspaceId,kind:"email",value:recipient,reason:input.eventType,source:input.provider,targetId:sent.target_id?String(sent.target_id):undefined});if(sent.target_id)db.prepare("UPDATE targets SET email_status='invalid' WHERE id=? AND workspace_id=?").run(sent.target_id,input.workspaceId);}
  const health=evaluateSenderHealth(String(sent.email_account_id));emitDomainEvent({workspaceId:input.workspaceId,type:`email.${input.eventType}`,entityType:"sent_message",entityId:String(sent.id),payload:{recipient,provider:input.provider,provider_event_id:input.providerEventId}});return{matched:true,duplicate:false,health};
}

export function evaluateSenderHealth(emailAccountId:string){const db=getDb();const policy=db.prepare("SELECT workspace_id,bounce_threshold,complaint_threshold,min_health_sample,paused_at,paused_reason FROM email_accounts WHERE id=?").get(emailAccountId) as {workspace_id:string;bounce_threshold:number;complaint_threshold:number;min_health_sample:number;paused_at:string|null;paused_reason:string|null}|undefined;if(!policy)return null;
  const sent=(db.prepare("SELECT COUNT(*) c FROM sent_messages WHERE email_account_id=? AND accepted_at>=datetime('now','-30 days')").get(emailAccountId) as {c:number}).c;const counts=db.prepare(`SELECT COUNT(CASE WHEN event_type='bounced' THEN 1 END) bounces,COUNT(CASE WHEN event_type='complained' THEN 1 END) complaints FROM sender_events WHERE email_account_id=? AND occurred_at>=datetime('now','-30 days')`).get(emailAccountId) as {bounces:number;complaints:number};const bounceRate=sent?counts.bounces/sent:0;const complaintRate=sent?counts.complaints/sent:0;let reason:string|null=null;if(sent>=policy.min_health_sample&&bounceRate>=policy.bounce_threshold)reason=`Auto-paused: 30-day bounce rate ${(bounceRate*100).toFixed(2)}% exceeds ${(policy.bounce_threshold*100).toFixed(2)}%`;if(sent>=policy.min_health_sample&&complaintRate>=policy.complaint_threshold)reason=`Auto-paused: 30-day complaint rate ${(complaintRate*100).toFixed(3)}% exceeds ${(policy.complaint_threshold*100).toFixed(3)}%`;if(reason&&!policy.paused_at){db.prepare("UPDATE email_accounts SET paused_at=datetime('now'),paused_reason=? WHERE id=?").run(reason,emailAccountId);emitDomainEvent({workspaceId:policy.workspace_id,type:"sender.auto_paused",entityType:"email_account",entityId:emailAccountId,payload:{reason,sent,bounce_rate:bounceRate,complaint_rate:complaintRate}});}return{sent,bounces:counts.bounces,complaints:counts.complaints,bounce_rate:bounceRate,complaint_rate:complaintRate,paused:Boolean(reason||policy.paused_at),reason:reason??policy.paused_reason};}

function assertSenderHealthy(account:Account){if(account.paused_at)throw new SafeSendError(account.paused_reason??"Sender is paused by the health policy");}
function receiptForJob(id:string):SendReceipt|null{const row=getDb().prepare("SELECT message_id,provider_message_id,smtp_response FROM sent_messages WHERE job_id=?").get(id) as {message_id:string;provider_message_id:string|null;smtp_response:string|null}|undefined;return row?{messageId:row.message_id,providerMessageId:row.provider_message_id??undefined,response:row.smtp_response??undefined}:null;}
function parseHeaders(value:string|null):Record<string,string>{if(!value)return{};try{return JSON.parse(value);}catch{return{};}}
function isAmbiguous(error:unknown){const code=String((error as {code?:string})?.code??"");return ["ETIMEDOUT","ECONNRESET","EPIPE","ESOCKET"].includes(code)||/timeout|connection.*closed|socket/i.test(message(error));}
function message(error:unknown){return error instanceof Error?error.message:String(error);}
class SafeSendError extends Error{}
