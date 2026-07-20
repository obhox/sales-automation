import NextAuth, { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { getDb } from "@/lib/db";
import { isRateLimited } from "@/lib/rate-limit";
import { createWorkspaceForUser, getMembership, getPrimaryMembership } from "@/lib/workspace";
import { isSuperadminEmail } from "@/lib/superadmin-allowlist";

type UserRow = { id: string; email: string; password_hash: string };

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, req) {
        if (!credentials?.email || !credentials?.password) return null;

        // Throttle login attempts per IP — this is the password brute-force surface.
        if (isRateLimited(req, "login", 10, 15 * 60 * 1000)) {
          throw new Error("Too many attempts. Try again later.");
        }

        const db = getDb();
        const user = db
          .prepare("SELECT id, email, password_hash FROM users WHERE email = ?")
          .get(credentials.email) as UserRow | undefined;

        if (!user) return null;

        const valid = await bcrypt.compare(credentials.password, user.password_hash);
        if (!valid) return null;

        return { id: user.id, email: user.email };
      },
    }),
  ],
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
  },
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      const userId = user?.id ?? token.userId ?? token.sub;
      if (!userId) return token;
      const requestedWorkspace = trigger === "update" && typeof session?.workspaceId === "string" ? session.workspaceId : null;
      let membership = requestedWorkspace ? getMembership(userId, requestedWorkspace) :
        !user && token.workspaceId ? getMembership(userId, token.workspaceId) : getPrimaryMembership(userId);
      if (!membership && (user?.email || token.email)) {
        createWorkspaceForUser(userId, String(user?.email ?? token.email));
        membership = getPrimaryMembership(userId);
      }
      token.userId = userId;
      token.workspaceId = membership?.workspaceId;
      token.workspaceName = membership?.workspaceName;
      token.role = membership?.role;
      // Recomputed on every token refresh so an allowlist change takes effect without
      // forcing a re-login. This flag is for UI affordances only - every admin route
      // re-checks the allowlist server-side and never trusts it.
      token.isSuperadmin = isSuperadminEmail(user?.email ?? token.email);
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.userId && token.workspaceId) {
        session.user.id = token.userId;
        session.user.workspaceId = token.workspaceId;
        session.user.workspaceName = token.workspaceName ?? "Workspace";
        session.user.role = token.role ?? "viewer";
      }
      if (session.user) session.user.isSuperadmin = Boolean(token.isSuperadmin);
      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
};

export default NextAuth(authOptions);
