import { Link, useLocation } from "react-router";
import { MOD_KEY } from "../components/Shell";
import { Kbd } from "../components/ui";
import { SectionHeading } from "../components/fx";
import { Page } from "../components/admin/Page";
import { useDocTitle } from "../lib/meta";

export function NotFound({ title = "Nothing here", body }: { title?: string; body?: string }) {
  const loc = useLocation();
  useDocTitle(title);
  return (
    <Page width="narrow">
      <div className="pt-14 md:pt-20">
        <p className="font-mono text-sm break-all text-fg-subtle">
          <span aria-hidden>$ </span>
          {loc.pathname}: no such page
        </p>
        <div className="mt-4">
          <SectionHeading as="h1" size="lg">
            {title}
          </SectionHeading>
        </div>
        <p className="mt-3 max-w-[56ch] text-base text-fg-muted">{body ?? "No page or skill lives at this address. The link may be old, or the skill was renamed or deleted."}</p>
        <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-3 text-sm">
          <Link
            to="/skills"
            className="inline-flex h-9 items-center rounded-md bg-primary px-3.5 font-medium text-on-primary transition-colors duration-[120ms] hover:bg-primary-hover max-md:min-h-11"
          >
            Browse all skills
          </Link>
          <Link to="/" className="inline-flex h-9 items-center rounded-md px-2 text-fg-muted transition-colors duration-[120ms] hover:text-fg max-md:min-h-11">
            Go home
          </Link>
          <span className="flex items-center gap-1.5 text-fg-subtle max-md:hidden">
            or press <Kbd>{MOD_KEY}</Kbd>
            <Kbd>K</Kbd> to jump anywhere
          </span>
        </div>
      </div>
    </Page>
  );
}
