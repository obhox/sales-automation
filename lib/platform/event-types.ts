// The events a workspace can subscribe a webhook to. Kept free of imports so the screen
// that offers them and the code that emits them read the same list.
export const EVENT_TYPES = [
  "email.sent", "email.opened", "email.clicked", "email.bounced", "email.unsubscribed", "sender.auto_paused",
  "reply.received", "reply.classified",
  "linkedin.connected", "linkedin.message_sent", "linkedin.signin_needed",
  "meeting.booked", "opportunity.stage_changed", "workflow.completed", "contact.created", "signal.received", "import.finished",
] as const;
