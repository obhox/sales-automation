// Writing a custom field from library code. Research generates a line per contact (a hook
// line) and has to put it somewhere a template can reach, which means the definition has
// to exist and the value has to land where loadTargetCustomValues will find it.
import { describe, expect, it, beforeAll } from "vitest";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import {
  CustomFieldNotText, UnusableCustomFieldKey,
  ensureTextCustomField, loadTargetCustomValues, writeTargetCustomText,
} from "@/lib/outreach/custom-values";
import { renderOutreachTemplate } from "@/lib/outreach/render";

const WS = "ws-customwrite-0001";
let contact: string;

beforeAll(() => {
  const db = getDb();
  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(WS, "Custom Write WS", "custom-write-ws");
  contact = randomUUID();
  db.prepare("INSERT INTO targets (id, workspace_id, full_name, linkedin_url) VALUES (?, ?, ?, ?)")
    .run(contact, WS, "Dale Cooper", `https://linkedin.com/in/${contact}`);
});

describe("ensureTextCustomField", () => {
  it("creates the definition once and finds it again, so research need not ask twice", () => {
    const db = getDb();
    const first = ensureTextCustomField(db, WS, { key: "hook_line", name: "Hook line" });
    const again = ensureTextCustomField(db, WS, { key: "hook_line", name: "Hook line" });
    expect(again).toBe(first);
    const count = db.prepare("SELECT COUNT(*) AS c FROM custom_field_definitions WHERE workspace_id = ? AND key = 'hook_line'").get(WS) as { c: number };
    expect(count.c).toBe(1);
  });

  it("normalises the key, because the renderer looks it up lower-cased", () => {
    const db = getDb();
    const id = ensureTextCustomField(db, WS, { key: "  Research_Note  ", name: "Research note" });
    const row = db.prepare("SELECT key FROM custom_field_definitions WHERE id = ?").get(id) as { key: string };
    expect(row.key).toBe("research_note");
  });

  it("refuses a key no template could reference", () => {
    const db = getDb();
    // renderOutreachTemplate only looks up /^[a-z][a-z0-9_]*$/, so anything else would be
    // written and then never render — a silent dead end.
    for (const key of ["2nd_hook", "hook-line", "hook line", ""]) {
      expect(() => ensureTextCustomField(db, WS, { key, name: "Nope" }), key).toThrow(UnusableCustomFieldKey);
    }
  });

  it("will not write text into a field the workspace made a number", () => {
    const db = getDb();
    db.prepare("INSERT INTO custom_field_definitions (id, workspace_id, name, key, field_type) VALUES (?, ?, ?, ?, 'number')")
      .run(randomUUID(), WS, "Deal size", "deal_size");
    expect(() => ensureTextCustomField(db, WS, { key: "deal_size", name: "Deal size" })).toThrow(CustomFieldNotText);
  });

  it("keeps each workspace's fields to itself", () => {
    const db = getDb();
    const other = "ws-customwrite-0002";
    db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(other, "Other", "other-cw-ws");
    const mine = ensureTextCustomField(db, WS, { key: "hook_line", name: "Hook line" });
    const theirs = ensureTextCustomField(db, other, { key: "hook_line", name: "Hook line" });
    expect(theirs).not.toBe(mine);
  });
});

describe("writeTargetCustomText", () => {
  it("lands where the renderer reads it, so {{hook_line}} resolves with no renderer change", () => {
    const db = getDb();
    const field = ensureTextCustomField(db, WS, { key: "hook_line", name: "Hook line" });
    writeTargetCustomText(db, WS, contact, field, "your pricing page still says beta");

    expect(loadTargetCustomValues(db, WS, contact).hook_line).toBe("your pricing page still says beta");
    const target = db.prepare("SELECT * FROM targets WHERE id = ?").get(contact) as Parameters<typeof renderOutreachTemplate>[1];
    expect(renderOutreachTemplate("Saw {{hook_line}}.", target, loadTargetCustomValues(db, WS, contact)))
      .toBe("Saw your pricing page still says beta.");
  });

  it("replaces the previous line rather than adding a second row", () => {
    const db = getDb();
    const field = ensureTextCustomField(db, WS, { key: "hook_line", name: "Hook line" });
    writeTargetCustomText(db, WS, contact, field, "first");
    writeTargetCustomText(db, WS, contact, field, "second");
    const rows = db.prepare("SELECT value_text FROM contact_custom_values WHERE target_id = ? AND field_id = ?").all(contact, field) as { value_text: string }[];
    expect(rows).toEqual([{ value_text: "second" }]);
  });

  it("clears the row on a blank line, so the template's fallback applies again", () => {
    const db = getDb();
    const field = ensureTextCustomField(db, WS, { key: "hook_line", name: "Hook line" });
    writeTargetCustomText(db, WS, contact, field, "something");
    writeTargetCustomText(db, WS, contact, field, "   ");

    // A stored "" would render as nothing and leave a hole in the sentence; an absent row
    // is what lets the fallback stand in.
    expect(db.prepare("SELECT COUNT(*) AS c FROM contact_custom_values WHERE target_id = ? AND field_id = ?").get(contact, field)).toEqual({ c: 0 });
    const target = db.prepare("SELECT * FROM targets WHERE id = ?").get(contact) as Parameters<typeof renderOutreachTemplate>[1];
    expect(renderOutreachTemplate("Saw {{hook_line|your work}}.", target, loadTargetCustomValues(db, WS, contact)))
      .toBe("Saw your work.");
  });

  it("writes workspace_id, which every reader filters on", () => {
    const db = getDb();
    const field = ensureTextCustomField(db, WS, { key: "hook_line", name: "Hook line" });
    writeTargetCustomText(db, WS, contact, field, "scoped");
    const row = db.prepare("SELECT workspace_id FROM contact_custom_values WHERE target_id = ? AND field_id = ?").get(contact, field) as { workspace_id: string };
    expect(row.workspace_id).toBe(WS);
  });
});
