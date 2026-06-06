import React, { useMemo } from "react";
import { Button, ButtonGroup } from "react-bootstrap";
import { FormattedNumber, useIntl } from "react-intl";

interface IPaginationProps {
  itemsPerPage: number;
  currentPage: number;
  totalItems: number;
  metadataByline?: React.ReactNode;
  onChangePage: (page: number) => void;
}

interface IPaginationIndexProps {
  itemsPerPage: number;
  currentPage: number;
  totalItems: number;
  metadataByline?: React.ReactNode;
}

function buildPageRange(current: number, total: number): (number | "…")[] {
  // Always show first + last; show current ± 2; collapse the rest into "…".
  // The "…" is clickable in the render layer (jumps halfway into the gap).
  const window = 2;
  const pages = new Set<number>();
  pages.add(1);
  pages.add(total);
  for (let i = current - window; i <= current + window; i++) {
    if (i >= 1 && i <= total) pages.add(i);
  }
  const sorted = Array.from(pages).sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  for (let i = 0; i < sorted.length; i++) {
    out.push(sorted[i]);
    if (i + 1 < sorted.length && sorted[i + 1] - sorted[i] > 1) {
      out.push("…");
    }
  }
  return out;
}

export const Pagination: React.FC<IPaginationProps> = ({
  itemsPerPage,
  currentPage,
  totalItems,
  onChangePage,
}) => {
  const intl = useIntl();
  const totalPages = useMemo(
    () => Math.ceil(totalItems / itemsPerPage),
    [totalItems, itemsPerPage]
  );

  const pageButtons = useMemo(() => {
    const range = buildPageRange(currentPage, totalPages);
    let gapIndex = 0;
    return range.map((entry) => {
      if (entry === "…") {
        // Each ellipsis "halves" the surrounding gap on click so the user can
        // walk forward / backward through long lists without typing.
        gapIndex++;
        return (
          <Button
            variant="secondary"
            key={`gap-${gapIndex}`}
            className="page-ellipsis"
            title={intl.formatMessage({ id: "pagination.jump" })}
            onClick={() => {
              // Find the surrounding numeric pages and jump to the midpoint.
              const idx = range.indexOf(entry);
              const prev = range
                .slice(0, idx)
                .reverse()
                .find((x): x is number => typeof x === "number");
              const next = range
                .slice(idx + 1)
                .find((x): x is number => typeof x === "number");
              if (prev != null && next != null) {
                onChangePage(Math.floor((prev + next) / 2));
              }
            }}
          >
            …
          </Button>
        );
      }
      return (
        <Button
          variant="secondary"
          key={entry}
          active={currentPage === entry}
          onClick={() => onChangePage(entry)}
        >
          <FormattedNumber value={entry} />
        </Button>
      );
    });
  }, [totalPages, currentPage, onChangePage, intl]);

  if (totalPages <= 1) return <div />;

  return (
    <ButtonGroup className="pagination">
      <Button
        variant="secondary"
        disabled={currentPage === 1}
        onClick={() => onChangePage(1)}
        title={intl.formatMessage({ id: "pagination.first" })}
      >
        <span>«</span>
      </Button>
      <Button
        variant="secondary"
        disabled={currentPage === 1}
        onClick={() => onChangePage(currentPage - 1)}
        title={intl.formatMessage({ id: "pagination.previous" })}
      >
        &lt;
      </Button>
      {pageButtons}
      <Button
        variant="secondary"
        disabled={currentPage === totalPages}
        onClick={() => onChangePage(currentPage + 1)}
        title={intl.formatMessage({ id: "pagination.next" })}
      >
        &gt;
      </Button>
      <Button
        variant="secondary"
        disabled={currentPage === totalPages}
        onClick={() => onChangePage(totalPages)}
        title={intl.formatMessage({ id: "pagination.last" })}
      >
        <span>»</span>
      </Button>
    </ButtonGroup>
  );
};

export const PaginationIndex: React.FC<IPaginationIndexProps> = ({
  itemsPerPage,
  currentPage,
  totalItems,
  metadataByline,
}) => {
  const intl = useIntl();

  // Build the pagination index string
  const firstItemCount: number = Math.min(
    (currentPage - 1) * itemsPerPage + 1,
    totalItems
  );
  const lastItemCount: number = Math.min(
    firstItemCount + (itemsPerPage - 1),
    totalItems
  );
  const indexText: string = `${intl.formatNumber(
    firstItemCount
  )}-${intl.formatNumber(lastItemCount)} of ${intl.formatNumber(totalItems)}`;

  return (
    <span className="filter-container text-muted paginationIndex center-text">
      {indexText}
      <br />
      {metadataByline}
    </span>
  );
};
