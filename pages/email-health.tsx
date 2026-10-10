import type { GetServerSideProps } from "next";

// Email health is part of the Deliverability screen now. Old links follow it there.
export const getServerSideProps: GetServerSideProps = async () => ({ redirect: { destination: "/deliverability", permanent: false } });

export default function EmailHealthRedirect() {
  return null;
}
