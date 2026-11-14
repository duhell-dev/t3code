import type { ReleaseHighlight } from "@t3tools/shared/releaseHighlights";

const DEFAULT_LIMIT = 8;

/** A release's curated highlights; the caller decides whether an empty list shows anything. */
export function ReleaseHighlightsList({
  highlights,
  limit = DEFAULT_LIMIT,
  className,
}: {
  readonly highlights: ReadonlyArray<ReleaseHighlight>;
  readonly limit?: number;
  readonly className?: string;
}) {
  const shown = highlights.slice(0, limit);
  const more = highlights.length - shown.length;
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
      {more > 0 ? (
        <p className="mt-1.5 pl-4 text-muted-foreground text-xs">
          {`and ${more} more ${more === 1 ? "highlight" : "highlights"}`}
        </p>
      ) : null}
    </div>
  );
}
