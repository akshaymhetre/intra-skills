// Loading shape for a SkillList: the same two lines and meta line as a SkillRow, so nothing jumps
// when the rows arrive.
import { Skeleton } from "../ui";
import { cx } from "../../lib/cx";

export function SkillListSkeleton({ rows = 6, ranked, className, label = "Loading skills" }: { rows?: number; ranked?: boolean; className?: string; label?: string }) {
  return (
    <ul className={cx("border-y border-line", className)} aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex gap-4 border-b border-line px-1 py-3.5 last:border-b-0 md:px-3">
          {ranked && <Skeleton className="mt-1 h-3.5 w-5" />}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <Skeleton className="h-4 w-48 max-w-[60%]" />
              <Skeleton className="h-3 w-10" />
            </div>
            <Skeleton className="mt-2.5 h-3 w-full max-w-xl" />
            <div className="mt-2.5 flex gap-4">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-32" />
            </div>
          </div>
          {/* Same columns as SkillRow's right side: trust bar, 7-day trend with count, the install button's slot. */}
          <div className="hidden shrink-0 items-center gap-5 pt-1.5 md:flex">
            <Skeleton className="h-1.5 w-14" />
            <span className="flex w-28 justify-end">
              <Skeleton className="h-4 w-24" />
            </span>
            <span className="w-[74px]" />
          </div>
        </li>
      ))}
    </ul>
  );
}
