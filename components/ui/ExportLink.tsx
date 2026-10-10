// A quiet link that downloads what a list is showing as a CSV file. Shown only to people
// the export route will answer (a manager and above).
import { useSession } from "next-auth/react";
import { RiDownloadLine } from "react-icons/ri";

const MAY_EXPORT = ["owner", "admin", "manager"];

interface Props {
  /** The export to take: contacts, list_members, replies, prospects, analytics or suppressions. */
  resource: string;
  /** The same query the screen sends for its own list, so the file matches what is shown. Paging is left out. */
  params?: URLSearchParams | Record<string, string>;
  className?: string;
}

export default function ExportLink({ resource, params, className = "" }: Props) {
  const { data: session } = useSession();
  if (!MAY_EXPORT.includes(session?.user?.role ?? "")) return null;
  const query = new URLSearchParams(params);
  query.delete("page");
  query.delete("limit");
  const search = query.toString();
  return (
    <a
      href={`/api/export/${resource}${search ? `?${search}` : ""}`} download
      className={`inline-flex shrink-0 items-center gap-1 text-[13px] text-base-content/50 underline-offset-2 transition-colors hover:text-base-content hover:underline ${className}`}
    >
      <RiDownloadLine size={13} aria-hidden /> Export CSV
    </a>
  );
}
