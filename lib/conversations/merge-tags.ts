// The merge tags a person can put in an answer from the inbox, and the one place the
// composer's list comes from.
//
// An answer's tags are filled when it is sent (fillMergeTags in lib/conversations/send.ts),
// by the same renderer campaign steps use, so a tag means the same thing in both.
//
// TO ADD WHEN THE SEQUENCE BUILDER'S BRANCH IS MERGED: that branch teaches
// renderOutreachTemplate the tags {{sender.name}}, {{sender.first_name}}, {{sender.email}}
// and {{custom.key}}, with an optional `sender` in its options. Two changes bring them here:
//   1. add the three sender tags to STANDARD_TAGS below (group "You"), and
//   2. pass the mailbox or LinkedIn account the answer goes from as `sender` where
//      fillMergeTags calls renderOutreachTemplate.
// Custom fields are already listed by their key, which is how the renderer reads them today.
import type DatabaseType from "better-sqlite3";

type DB = DatabaseType.Database;

export interface MergeTag {
  /** What is typed between the braces. */
  tag: string;
  label: string;
  group: "Contact" | "Custom fields" | "You";
}

const STANDARD_TAGS: MergeTag[] = [
  { tag: "first_name", label: "First name", group: "Contact" },
  { tag: "last_name", label: "Last name", group: "Contact" },
  { tag: "full_name", label: "Full name", group: "Contact" },
  { tag: "company", label: "Company", group: "Contact" },
  { tag: "title", label: "Job title", group: "Contact" },
  { tag: "location", label: "Location", group: "Contact" },
];

/** Every tag an answer in this workspace can use: the contact's own fields, then the workspace's custom fields. */
export function mergeTagsFor(db: DB, workspaceId: string): MergeTag[] {
  const custom = db.prepare("SELECT key, name FROM custom_field_definitions WHERE workspace_id = ? ORDER BY name").all(workspaceId) as Array<{ key: string; name: string }>;
  return [...STANDARD_TAGS, ...custom.map((field): MergeTag => ({ tag: field.key, label: field.name, group: "Custom fields" }))];
}
