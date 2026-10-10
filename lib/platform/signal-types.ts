// The kinds of buying signal a workspace can record and write rules for. Kept free of
// imports so the screens that offer them and the routes that check them read one list.
export const SIGNAL_TYPES = ["job_change", "funding", "hiring", "technology", "product_intent", "custom"] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

export const SIGNAL_TYPE_LABELS: Record<SignalType, string> = {
  job_change: "Job change", funding: "Funding", hiring: "Hiring", technology: "Technology",
  product_intent: "Product intent", custom: "Custom",
};
