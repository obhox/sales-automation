import en from "@/messages/en.json";
import ptBR from "@/messages/pt-BR.json";
import {knownAuthErrorKeys} from "./localize-auth-error";

export type ErrorLocale = "pt-BR" | "en";

// Keep the API's existing response fields and error strings unchanged.
// Only the text displayed to the user is localized.
const messageKeys = {
  "Your session has ended. Sign in again.": "sessionEnded",
  "You do not have permission to do this.": "forbidden",
  "This could not be found.": "notFound",
  "Too many requests. Try again in a moment.": "rateLimit",
  "The server could not be reached. Check your connection and try again.": "offline",
  "Something went wrong.": "generic",
  "User not found.": "userNotFound",
  "Account access is required.": "accountRequired",
} as const;

export function localizeRequestError(message: string, locale: ErrorLocale): string {
  const dictionary = locale === "pt-BR" ? ptBR : en;
  const authKey = knownAuthErrorKeys[message as keyof typeof knownAuthErrorKeys];
  if (authKey) return dictionary.AuthErrors[authKey];
  const key = messageKeys[message as keyof typeof messageKeys];
  if (key) return dictionary.RequestErrors[key];
  const match = /^The request failed \((\d+)\)\.$/.exec(message);
  if (match) return dictionary.RequestErrors.requestFailed.replace("{status}", match[1]);
  return message; // Preserve unknown provider/server details.
}

export function currentErrorLocale(): ErrorLocale {
  // Server rendering and unit tests have no document. Keep the original
  // English fallback there; the browser uses the same locale cookie as the UI.
  if (typeof document === "undefined") return "en";
  const raw = document.cookie.split("; ").find((cookie) => cookie.startsWith("LINKI_UI_LOCALE="))?.split("=")[1];
  return raw === "en" ? "en" : "pt-BR";
}
