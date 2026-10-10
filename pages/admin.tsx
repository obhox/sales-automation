import type { GetServerSidePropsContext } from "next";
import { getSuperadmin } from "@/lib/superadmin";

// The instance operator's dashboard. Gated on the server: anyone not on the instance's
// own allowlist gets a 404, so the page cannot be found by trying its address.
export { AdminScreen as default } from "@/components/admin/AdminScreen";

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
  const viewer = await getSuperadmin(ctx);
  // 404 rather than a redirect: a normal user should not learn this page exists.
  if (!viewer) return { notFound: true };
  return { props: { viewer } };
}
