// Making sure every reply is filed under a conversation.
//
// The code that stores a reply files it at once. This is for what that cannot see: the
// replies stored before conversations existed (the one-time backfill), a contact marked
// as replied with no message on record, and anything a later change stores without
// filing. It is cheap when there is nothing to do, which is nearly always.
import type DatabaseType from "better-sqlite3";
import { ensureConversationForTarget, fileReply } from "@/lib/conversations/rows";

type DB = DatabaseType.Database;

/**
 * File what is not filed, for one workspace or (with none named) for all of them.
 * Returns how many conversations were made.
 */
export function reconcileConversations(db: DB, workspaceId?: string): number {
  const scope = workspaceId ? "AND workspace_id = ?" : "";
  const params = workspaceId ? [workspaceId] : [];
  let made = 0;
  db.transaction(() => {
    // Contacts first, each once: a conversation made for a contact takes in all their replies.
    const contacts = db.prepare(`SELECT DISTINCT target_id AS id FROM email_replies WHERE conversation_id IS NULL AND target_id IS NOT NULL ${scope}
      UNION
      SELECT t.id FROM targets t WHERE (t.email_replied_at IS NOT NULL OR t.last_replied_at IS NOT NULL) ${scope.replace("workspace_id", "t.workspace_id")}
        AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.target_id = t.id)`).all(...params, ...params) as Array<{ id: string }>;
    for (const contact of contacts) if (ensureConversationForTarget(db, contact.id)?.created) made++;
    // What is left: replies with no contact, and replies whose contact already had a
    // conversation. Oldest first, so each is weighed against what came before it.
    const loose = db.prepare(`SELECT id FROM email_replies WHERE conversation_id IS NULL ${scope} ORDER BY datetime(received_at), rowid`).all(...params) as Array<{ id: string }>;
    for (const reply of loose) if (fileReply(db, reply.id)?.created) made++;
    // A conversation whose contact was deleted and that holds no reply (they were only
    // marked as replied, or only their LinkedIn messages were kept) has nothing left in it.
    db.prepare(`DELETE FROM conversations WHERE target_id IS NULL ${scope} AND NOT EXISTS (SELECT 1 FROM email_replies er WHERE er.conversation_id = conversations.id)`).run(...params);
  })();
  return made;
}

/** The one-time pass over everything stored before conversations existed. */
export function backfillConversations(db: DB): number {
  return reconcileConversations(db);
}
