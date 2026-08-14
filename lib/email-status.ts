import type { IconType } from "react-icons";
import { RiMailCheckLine, RiMailForbidLine, RiAtLine, RiQuestionLine, RiAlertLine } from "react-icons/ri";

/**
 * How a contact's `email_status` is presented.
 *
 * The states exist because they mean genuinely different things, and collapsing them is what
 * made a working check look broken: every address that was not mailbox-probed rendered as an
 * amber warning, including addresses that had just passed every check available.
 *
 *   verified   — a mail server confirmed the mailbox exists (SMTP RCPT probe).
 *   checked    — syntax, domain, MX and disposable checks passed; mailbox not probed.
 *   invalid    — proven dead or disposable. Suppressed.
 *   catchall   — the domain accepts anything, so delivery proves nothing. Do-not-send.
 *   unverified — the check ran but could not conclude (DNS blip, unreachable server).
 *   (null)     — never checked.
 *
 * `checked` is deliberately not a warning. It is the normal, healthy outcome of the bulk
 * check, and the strongest statement an API that does not probe mailboxes can make.
 */
export interface EmailStatusBadge {
  icon: IconType;
  className: string;
  /** Short word for a chip. */
  label: string;
  /** Sentence for a tooltip — says what the state actually means. */
  title: string;
}

export function emailStatusBadge(status: string | null | undefined): EmailStatusBadge {
  switch (status) {
    case "verified":
      return { icon: RiMailCheckLine, className: "text-success", label: "verified", title: "Verified — mailbox confirmed to exist" };
    case "checked":
      return { icon: RiMailCheckLine, className: "text-success/70", label: "checked", title: "Checked — domain accepts mail, mailbox not probed" };
    case "invalid":
      return { icon: RiMailForbidLine, className: "text-error", label: "invalid", title: "Invalid — will not be sent to" };
    case "catchall":
      return { icon: RiAlertLine, className: "text-warning", label: "catch-all", title: "Catch-all domain — accepts any address, so delivery proves nothing" };
    case "unverified":
      return { icon: RiQuestionLine, className: "text-base-content/40", label: "inconclusive", title: "Inconclusive — the check could not reach an answer" };
    default:
      return { icon: RiAtLine, className: "text-base-content/30", label: "unchecked", title: "Not checked yet" };
  }
}
