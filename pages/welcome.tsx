import Head from "next/head";
import type { GetServerSideProps } from "next";
import type { Session } from "next-auth";
import { WelcomePage } from "@/components/welcome/WelcomePage";
import { META } from "@/components/welcome/content";

/**
 * What Linki is, for a visitor who is not signed in. Anyone may open it (proxy.ts), and
 * an instance can make it the front door with LINKI_WELCOME_PAGE=on.
 *
 * The session is read here so the page arrives complete in the first response. Without
 * it the app waits on the browser to ask who is signed in before drawing anything, and
 * a link preview or a search engine would be sent a spinner.
 */
export const getServerSideProps: GetServerSideProps<{ session: Session | null; signedIn: boolean; origin: string }> = async ({ req, res }) => {
  const { getServerSession } = await import("next-auth/next");
  const { authOptions } = await import("@/pages/api/auth/[...nextauth]");
  const session = await getServerSession(req, res, authOptions);
  // The address this instance is reached at: the one it was configured with, else the one asked for.
  const configured = process.env.NEXTAUTH_URL?.trim().replace(/\/+$/, "");
  const forwarded = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const origin = configured || `${forwarded || "http"}://${req.headers.host ?? "localhost"}`;
  // A session can hold fields that are undefined (a user with no name), which cannot be sent to the page as they are.
  // `session` is taken by pages/_app.tsx for the whole app and never reaches this page, hence `signedIn` beside it.
  return { props: { session: session ? (JSON.parse(JSON.stringify(session)) as Session) : null, signedIn: Boolean(session), origin } };
};

export default function Welcome({ signedIn, origin }: { signedIn: boolean; origin: string }) {
  const url = `${origin}/welcome`;
  const image = `${origin}${META.image.src}`;
  return (
    <>
      <Head>
        <title>{META.title}</title>
        <meta name="description" content={META.description} />
        <link rel="canonical" href={url} />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Linki" />
        <meta property="og:title" content={META.title} />
        <meta property="og:description" content={META.description} />
        <meta property="og:url" content={url} />
        <meta property="og:image" content={image} />
        <meta property="og:image:width" content={String(META.image.width)} />
        <meta property="og:image:height" content={String(META.image.height)} />
        <meta property="og:image:alt" content={META.image.alt} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={META.title} />
        <meta name="twitter:description" content={META.description} />
        <meta name="twitter:image" content={image} />
      </Head>
      <WelcomePage origin={origin} signedIn={signedIn} />
    </>
  );
}
