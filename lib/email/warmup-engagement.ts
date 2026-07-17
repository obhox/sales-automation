import Imap from "imap";
import { getDb } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { sendEmailDurably } from "@/lib/email/infrastructure";

type WarmupRow={id:string;workspace_id:string;from_account_id:string;to_account_id:string;subject:string;reply_rate:number;sender_email:string;sent_at:string};
type ImapAccount={id:string;imap_host:string|null;imap_port:number|null;username:string;password:string;imap_username:string|null;imap_password:string|null;allow_self_signed:number};

/** Marks controlled warmup messages important, rescues them from spam/junk, and sends
 * deterministic delayed replies according to the configured reply rate. */
export async function processWarmupEngagement(limit=10){
  const db=getDb();const rows=db.prepare(`SELECT wm.id,wm.workspace_id,wm.from_account_id,wm.to_account_id,wm.subject,wm.sent_at,
    ws.reply_rate,sender.from_email sender_email FROM warmup_messages wm JOIN warmup_settings ws ON ws.email_account_id=wm.from_account_id
    JOIN email_accounts sender ON sender.id=wm.from_account_id WHERE wm.status='sent' AND wm.engaged_at IS NULL
    AND wm.sent_at<=datetime('now','-5 minutes') ORDER BY wm.sent_at LIMIT ?`).all(limit) as WarmupRow[];
  for(const row of rows){
    const receiver=db.prepare("SELECT id,imap_host,imap_port,username,password,imap_username,imap_password,allow_self_signed FROM email_accounts WHERE id=?").get(row.to_account_id) as ImapAccount|undefined;
    let engagement={found:false,rescued:false};if(receiver?.imap_host)engagement=await engageMailbox(receiver,row.id).catch(()=>engagement);
    if(!engagement.found&&Date.now()-Date.parse(row.sent_at)<60*60_000)continue;
    db.prepare("UPDATE warmup_messages SET engaged_at=datetime('now'),rescued_at=CASE WHEN ? THEN datetime('now') ELSE rescued_at END WHERE id=?").run(engagement.rescued?1:0,row.id);
    if(shouldReply(row.id,row.reply_rate)){
      try{await sendEmailDurably({workspaceId:row.workspace_id,emailAccountId:row.to_account_id,idempotencyKey:`warmup-reply:${row.id}`,source:"warmup_reply",to:row.sender_email,subject:`Re: ${row.subject}`,body:"Thanks — received this clearly. I’ll follow up when I have the next update.",headers:{"X-Linki-Warmup-Reply-To":row.id}});db.prepare("UPDATE warmup_messages SET replied_at=datetime('now') WHERE id=?").run(row.id);}catch{}
    }
  }return rows.length;
}

async function engageMailbox(account:ImapAccount,warmupId:string):Promise<{found:boolean;rescued:boolean}>{
  return new Promise((resolve,reject)=>{const imap=new Imap({host:account.imap_host!,port:account.imap_port??993,tls:true,tlsOptions:{rejectUnauthorized:account.allow_self_signed!==1,servername:account.imap_host!},user:account.imap_username??account.username,password:decryptSecret(account.imap_password)??decryptSecret(account.password)!,authTimeout:10_000,connTimeout:12_000});let done=false;
    const finish=(value:{found:boolean;rescued:boolean})=>{if(done)return;done=true;try{imap.end();}catch{}resolve(value)};imap.once("error",reject);imap.once("ready",()=>{imap.getBoxes((error,boxes)=>{if(error){finish({found:false,rescued:false});return;}const names=flattenBoxes(boxes);const spam=names.find(x=>/^(spam|junk|junk email)$/i.test(x));const candidates=[...(spam?[spam]:[]),...names.filter(x=>/^inbox$/i.test(x))];let index=0;const next=()=>{const box=candidates[index++];if(!box){finish({found:false,rescued:false});return;}imap.openBox(box,false,err=>{if(err){next();return;}imap.search([["HEADER","X-Linki-Warmup-ID",warmupId]],(searchErr,uids)=>{if(searchErr||!uids.length){next();return;}const uid=uids[uids.length-1];imap.addFlags(uid,["\\Flagged","$Important"],()=>{if(spam&&box===spam)imap.move(uid,"INBOX",()=>finish({found:true,rescued:true}));else finish({found:true,rescued:false});});});});};next();});});imap.connect();});
}
function flattenBoxes(boxes:Imap.MailBoxes,prefix=""):string[]{const out:string[]=[];for(const[name,box]of Object.entries(boxes)){const full=prefix?`${prefix}${box.delimiter}${name}`:name;out.push(full);if(box.children)out.push(...flattenBoxes(box.children,full));}return out;}
function shouldReply(id:string,rate:number){let hash=0;for(const char of id)hash=(hash*31+char.charCodeAt(0))>>>0;return hash%100<Math.max(0,Math.min(100,rate));}
