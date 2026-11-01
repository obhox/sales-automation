// Translate known user-facing API errors without modifying the API wire protocol.
// Unknown messages are preserved to avoid hiding actionable server diagnostics.
export const knownAuthErrorKeys = {
  "Too many attempts. Try again later.": "rateLimit",
  "Email is required.": "emailRequired",
  "Password is required.": "passwordRequired",
  "Email and password are required.": "emailPasswordRequired",
  "An account with this email already exists.": "duplicateEmail",
  "This invitation is invalid, expired, or belongs to another email address.": "invalidInvite",
  "Email confirmation is not set up on this server.": "emailConfirmationNotSet",
  "Password reset by email is not set up on this server. Ask whoever runs it to reset your password.": "passwordResetNotSet",
  "This reset link has expired or was already used. Ask for a new one.": "resetExpired",
  "This confirmation link has expired or was already used.": "confirmationExpired",
  "Use at least 8 characters.": "minEight",
  "The two passwords don't match.": "passwordMismatch",
  "New password must be at least 8 characters.": "passwordMinEight",
  "Current password is incorrect.": "currentPasswordIncorrect",
  "Not authenticated": "notAuthenticated",
  "Invalid email address": "invalidEmail",
} as const;

export type AuthErrorKey = (typeof knownAuthErrorKeys)[keyof typeof knownAuthErrorKeys] | "generic" | "network" | "signupFailed" | "emailFailed";
export function localizeAuthError(
  message: unknown,
  t: (key: AuthErrorKey) => string,
  fallback: AuthErrorKey = "generic",
): string {
  if (typeof message !== "string" || !message.trim()) return t(fallback);
  const key = knownAuthErrorKeys[message as keyof typeof knownAuthErrorKeys];
  return key ? t(key) : message;
}
