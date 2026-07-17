import type Database from "better-sqlite3";

export interface WorkflowCondition { field: string; operator: "is" | "is_not" | "contains" | "exists" | "not_exists" | "gt" | "gte" | "lt" | "lte"; value?: unknown }
export interface ConditionGroup { mode?: "all" | "any"; conditions: WorkflowCondition[] }

export function evaluateWorkflowConditions(db: Database.Database, targetId: string, group: ConditionGroup): boolean {
  const target = db.prepare("SELECT * FROM targets WHERE id = ?").get(targetId) as Record<string, unknown> | undefined;
  if (!target) return false;
  const results = (group.conditions ?? []).map((condition) => evaluateOne(db, targetId, target, condition));
  if (results.length === 0) return true;
  return group.mode === "any" ? results.some(Boolean) : results.every(Boolean);
}

function evaluateOne(db: Database.Database, targetId: string, target: Record<string, unknown>, condition: WorkflowCondition): boolean {
  let actual: unknown;
  switch (condition.field) {
    case "connected": actual = Number(target.degree) === 1 || !!target.connected_at; break;
    case "replied": actual = !!target.last_replied_at || !!target.email_replied_at; break;
    case "email_found": actual = !!target.email; break;
    case "intent_score": actual = Number(target.intent_score ?? 0); break;
    case "signal_exists": actual = !!db.prepare("SELECT 1 FROM signals WHERE target_id = ? AND type = ? LIMIT 1").get(targetId, String(condition.value ?? "custom")); break;
    default:
      if (condition.field.startsWith("custom.")) {
        const key = condition.field.slice(7);
        const row = db.prepare(`SELECT ccv.value_text, ccv.value_number, ccv.value_boolean, cfd.field_type
          FROM contact_custom_values ccv JOIN custom_field_definitions cfd ON cfd.id = ccv.field_id
          WHERE ccv.target_id = ? AND cfd.key = ?`).get(targetId, key) as { value_text: string | null; value_number: number | null; value_boolean: number | null; field_type: string } | undefined;
        actual = row?.field_type === "number" ? row.value_number : row?.field_type === "boolean" ? !!row.value_boolean : row?.value_text;
      } else actual = target[condition.field];
  }
  return compare(actual, condition.operator, condition.value);
}

function compare(actual: unknown, operator: WorkflowCondition["operator"], expected: unknown): boolean {
  if (operator === "exists") return actual !== null && actual !== undefined && actual !== "" && actual !== false;
  if (operator === "not_exists") return actual === null || actual === undefined || actual === "" || actual === false;
  if (operator === "contains") return String(actual ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
  if (operator === "is") return String(actual ?? "").toLowerCase() === String(expected ?? "").toLowerCase();
  if (operator === "is_not") return String(actual ?? "").toLowerCase() !== String(expected ?? "").toLowerCase();
  const a = Number(actual), b = Number(expected);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (operator === "gt") return a > b;
  if (operator === "gte") return a >= b;
  if (operator === "lt") return a < b;
  return a <= b;
}

