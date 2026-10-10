// What a contact actually receives from a template: merge tags and their fallbacks, wording
// alternatives, and the mistakes the preview is expected to point out.
import { describe, expect, it } from "vitest";
import { lintTemplate, renderOutreachTemplate } from "@/lib/outreach/render";
import { seededPick, seededUnit } from "@/lib/outreach/seed";

const lee = { first_name: "Lee", last_name: "Lead", full_name: "Lee Lead", company: "Initech", title: "CTO", location: "Leeds" };

describe("merge tags", () => {
  it("are filled from the contact, whatever the spacing or case", () => {
    expect(renderOutreachTemplate("Hi {{first_name}} at {{ Company }}", lee)).toBe("Hi Lee at Initech");
  });

  it("fall back to the full name's parts when the contact has no separate first or last name", () => {
    expect(renderOutreachTemplate("{{first_name}} / {{last_name}}", { full_name: "Ada King Lovelace" })).toBe("Ada / King Lovelace");
  });

  it("use the text after the bar when the contact has nothing for them", () => {
    expect(renderOutreachTemplate("Hi {{first_name|there}}", {})).toBe("Hi there");
    expect(renderOutreachTemplate("Hi {{first_name | there}}", { first_name: "  " })).toBe("Hi there");
    expect(renderOutreachTemplate("Hi {{first_name|there}}", lee)).toBe("Hi Lee");
  });

  it("render as nothing without a fallback, as before", () => {
    expect(renderOutreachTemplate("Hi {{first_name}}!", {})).toBe("Hi !");
  });

  it("take custom fields, which can never stand in for a standard one", () => {
    expect(renderOutreachTemplate("{{pain_point}} / {{company}}", lee, { pain_point: "churn", company: "Evil Corp" })).toBe("churn / Initech");
  });

  it("fall back for a custom field the contact has no value for", () => {
    expect(renderOutreachTemplate("About {{pain_point|your roadmap}}", lee, { pain_point: "" })).toBe("About your roadmap");
    expect(renderOutreachTemplate("About {{pain_point}}.", lee, { pain_point: "" })).toBe("About .");
  });

  it("are left as written when they name nothing, unless a fallback was given", () => {
    expect(renderOutreachTemplate("Hi {{frist_name}}", lee)).toBe("Hi {{frist_name}}");
    expect(renderOutreachTemplate("Hi {{frist_name|there}}", lee)).toBe("Hi there");
  });
});

describe("wording alternatives", () => {
  it("become one of the choices, the same one for the same seed", () => {
    const template = "{Hi|Hello|Hey} {{first_name}}, {quick question|one thing}";
    const first = renderOutreachTemplate(template, lee, null, { seed: "track-1:step-1" });
    expect(renderOutreachTemplate(template, lee, null, { seed: "track-1:step-1" })).toBe(first);
    expect(first).toMatch(/^(Hi|Hello|Hey) Lee, (quick question|one thing)$/);
  });

  it("differ between contacts", () => {
    const template = "{a|b|c|d|e|f|g|h}";
    const seen = new Set(Array.from({ length: 40 }, (_, i) => renderOutreachTemplate(template, lee, null, { seed: `track-${i}:step-1` })));
    expect(seen.size).toBeGreaterThan(3);
  });

  it("are picked independently of each other within one message", () => {
    const template = "{a|b}{a|b}{a|b}{a|b}{a|b}{a|b}";
    const seen = new Set(Array.from({ length: 20 }, (_, i) => renderOutreachTemplate(template, lee, null, { seed: `s${i}` })));
    expect([...seen].some((text) => new Set(text).size > 1)).toBe(true);
  });

  it("can be nested, and can be empty", () => {
    expect(renderOutreachTemplate("{Hi {there|friend}|Hello}", lee, null, { seed: "x" })).toMatch(/^(Hi there|Hi friend|Hello)$/);
    expect(renderOutreachTemplate("Thanks{ so much|}!", lee, null, { seed: "x" })).toMatch(/^Thanks( so much)?!$/);
  });

  it("leave ordinary braces alone", () => {
    expect(renderOutreachTemplate("Use {curly} braces and a | pipe", lee, null, { seed: "x" })).toBe("Use {curly} braces and a | pipe");
  });

  it("never read a contact's own data as a choice", () => {
    const odd = { first_name: "{Lee|Robert'); DROP}", company: "A|B {Corp|Inc}" };
    expect(renderOutreachTemplate("{Hi|Hi} {{first_name}} at {{company}}", odd, null, { seed: "x" })).toBe("Hi {Lee|Robert'); DROP} at A|B {Corp|Inc}");
    expect(renderOutreachTemplate("{{note}}", lee, { note: "{{first_name}} {x|y}" }, { seed: "x" })).toBe("{{first_name}} {x|y}");
  });

  it("keep a fallback's bar out of it", () => {
    expect(renderOutreachTemplate("{Hi|Hello} {{first_name|there}}", {}, null, { seed: "x" })).toMatch(/^(Hi|Hello) there$/);
  });

  it("are random when no seed is given", () => {
    const seen = new Set(Array.from({ length: 60 }, () => renderOutreachTemplate("{a|b|c|d}", lee)));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("seeded picks", () => {
  it("are stable and stay inside the list", () => {
    const items = ["a", "b", "c"];
    for (const seed of ["", "x", "track:step", "0", "a much longer seed with spaces"]) {
      expect(seededPick(seed, items)).toBe(seededPick(seed, items));
      expect(items).toContain(seededPick(seed, items));
      expect(seededUnit(seed)).toBeGreaterThanOrEqual(0);
      expect(seededUnit(seed)).toBeLessThan(1);
    }
  });

  it("spread evenly enough to be an A/B split", () => {
    const counts = [0, 0];
    for (let i = 0; i < 2000; i++) counts[seededPick(`track-${i}:step-a`, [0, 1])]++;
    expect(counts[0]).toBeGreaterThan(850);
    expect(counts[1]).toBeGreaterThan(850);
  });
});

describe("lintTemplate", () => {
  it("has nothing to say about a sound template", () => {
    expect(lintTemplate("{Hi|Hello} {{first_name|there}}, about {{pain_point}}", ["pain_point"])).toEqual([]);
  });

  it("names a tag that is not a field", () => {
    expect(lintTemplate("Hi {{frist_name}} and {{frist_name|x}}")).toEqual(["{{frist_name}} is not a field on a contact. It will be sent as written."]);
  });

  it("notices braces that do not close", () => {
    expect(lintTemplate("Hi {{first_name}")[0]).toMatch(/not closed/);
    expect(lintTemplate("{Hi|Hello there")[0]).toMatch(/not closed/);
    expect(lintTemplate("Hi|Hello} there")[0]).toMatch(/not closed/);
  });
});
