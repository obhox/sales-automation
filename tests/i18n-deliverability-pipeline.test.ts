import {describe, expect, it} from "vitest";
import {createTranslator} from "next-intl";
import en from "../messages/en.json";
import pt from "../messages/pt-BR.json";
import {STATUS_FILTERS, MANUAL_PLACEMENTS, EVENT_KIND_LABEL} from "../components/deliverability/model";
import {TASK_SCOPES, ACTIVITY_GROUPS} from "../components/pipeline/model";

const br = createTranslator({locale:"pt-BR", messages:pt});
const english = createTranslator({locale:"en", messages:en});

describe("deliverability and pipeline workflow localization", () => {
  it("translates domain authentication, DNS controls and scoring", () => {
    expect(br("Deliverability.title")).toBe("Entregabilidade");
    expect(br("Deliverability.score", {score:85})).toContain("85");
    expect(br("DeliverabilityDns.checked", {domain:"example.com"})).toContain("example.com");
    expect(br("DeliverabilityDns.changes", {count:3})).toContain("3");
    expect(br("DeliverabilityWarmup.confirmBody", {count:2})).toContain("2");
    expect(english("Deliverability.last30")).toBe("Last 30 days");
  });

  it("preserves filter identifiers while translating mailbox health and guard events", () => {
    for (const filter of STATUS_FILTERS) {
      expect(br.has(`DeliverabilityMailbox.status.${filter.value}`)).toBe(true);
      expect(english.has(`DeliverabilityMailbox.status.${filter.value}`)).toBe(true);
    }
    for (const kind of Object.keys(EVENT_KIND_LABEL)) {
      expect(br.has(`DeliverabilityGuard.kinds.${kind}`)).toBe(true);
    }
    expect(br("DeliverabilityMailbox.rotation", {mode:"sequencial"})).toContain("sequencial");
    expect(br("DeliverabilityGuard.title")).toContain("proteção");
  });

  it("preserves suppression warnings and test results", () => {
    expect(br("DeliverabilityDnc.protectedWarning")).toContain("cancelou a inscrição");
    expect(br("DeliverabilityDnc.protectedWarning")).toContain("legislação");
    expect(br("DeliverabilityDnc.removeTitle", {value:"person@example.com"})).toContain("person@example.com");
    for (const placement of MANUAL_PLACEMENTS) {
      expect(br.has(`DeliverabilityPlacement.placements.${placement}`)).toBe(true);
    }
    expect(br("DeliverabilityPlacement.sent", {count:4})).toContain("4");
  });

  it("translates task controls without changing statuses, priorities and scopes", () => {
    for (const scope of TASK_SCOPES) expect(br.has(`PipelineTasks.scopes.${scope.value}`)).toBe(true);
    for (const priority of ["high", "medium", "low"]) {
      expect(br.has(`PipelineTasks.priorityOptions.${priority}`)).toBe(true);
    }
    expect(br("PipelineTasks.complete", {name:"Contato"})).toContain("Contato");
    expect(br("PipelineTasks.whatError")).toContain("Descreva");
    expect(english("PipelineTasks.new")).toBe("New task");
  });

  it("translates activity categories while preserving group codes", () => {
    for (const group of ACTIVITY_GROUPS) {
      expect(br.has(`PipelineActivity.groups.${group.value}`)).toBe(true);
      expect(english.has(`PipelineActivity.groups.${group.value}`)).toBe(true);
    }
    expect(br("PipelineActivity.log")).toContain("ligação");
    expect(br("PipelineActivity.types.call")).toBe("Ligação");
    expect(br("PipelineActivity.savedNote")).toBe("Nota salva");
  });
});
