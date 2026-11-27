import type { ReleaseHighlight } from "@t3tools/shared/releaseHighlights";
import { useGT } from "gt-react";
import { useState } from "react";

const DEFAULT_LIMIT = 8;

/**
 * A release's curated highlights; the caller decides whether an empty list shows anything.
 * Past `limit`, a button shows the rest. Tooltips cannot take a click, so they pass
 * `expandable={false}` and keep a plain count.
 */
export function ReleaseHighlightsList({
  highlights,
  limit = DEFAULT_LIMIT,
  expandable = true,
  className,
}: {
  readonly highlights: ReadonlyArray<ReleaseHighlight>;
  readonly limit?: number;
  readonly expandable?: boolean;
  readonly className?: string;
}) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? highlights : highlights.slice(0, limit);
  const more = highlights.length - Math.min(limit, highlights.length);
  return (
    <div className={className}>
      <ul className="space-y-1.5 pl-4 text-xs leading-5 text-popover-foreground/90">
        {shown.map(({ title, detail }) => (
          <li className="list-disc break-words" key={`${title}\n${detail}`}>
            <strong>{title}</strong>
            {detail ? ` ${detail}` : null}
          </li>
        ))}
      </ul>
      {more > 0 && expandable ? (
        <button
          type="button"
          aria-expanded={expanded}
          className="mt-1.5 ml-4 cursor-pointer rounded-sm text-muted-foreground text-xs underline-offset-4 outline-hidden hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? gt("Show fewer", { $context: "button, collapses a list of release highlights" })
            : gt(
                "{count, plural, one {Show all {count} highlight} other {Show all {count} highlights}}",
                { count: highlights.length },
              )}
        </button>
      ) : more > 0 ? (
        <p className="mt-1.5 pl-4 text-muted-foreground text-xs">
          {gt(
            "{count, plural, one {and {count} more highlight} other {and {count} more highlights}}",
            {
              count: more,
            },
          )}
        </p>
      ) : null}
    </div>
  );
}
