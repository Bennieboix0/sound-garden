import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { PageRenderer, PageRequest } from '../../pdf/render';
import { Spinner, cx } from '../ui/controls';

export type TurnDirection = 'next' | 'prev' | null;

/** Gap between the two halves of a spread, in CSS pixels. */
export const SPREAD_GAP = 16;

function requestKey(request: PageRequest): string {
  return `${request.scoreId}:${request.pageNumber}`;
}

/**
 * Displays one or two already-rendered pages, each with an optional overlay.
 *
 * The important property is that a cache hit is mounted synchronously inside a
 * layout effect: the new page is in the DOM before the browser paints the frame
 * in which the pedal press was handled, so a turn has no visible delay. Only a
 * miss falls back to the asynchronous path, which keeps the previous page on
 * screen rather than flashing empty.
 */
export default function PageSurface({
  renderer,
  requests,
  invert,
  animate,
  direction,
  renderOverlay,
}: {
  renderer: PageRenderer;
  requests: PageRequest[];
  invert: boolean;
  animate: boolean;
  direction: TurnDirection;
  /** Drawn above each page, in the page's own coordinate box. */
  renderOverlay?: (request: PageRequest) => ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const hosts = useRef(new Map<string, HTMLDivElement | null>());
  const [waiting, setWaiting] = useState(false);
  const [showSpinner, setShowSpinner] = useState(false);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || requests.length === 0) return;

    const mount = (canvases: (HTMLCanvasElement | null)[]) => {
      requests.forEach((request, index) => {
        const canvas = canvases[index];
        const host = hosts.current.get(requestKey(request));
        if (!canvas || !host) return;
        canvas.className = 'block shadow-2xl';
        // The canvas carries its own CSS size, so the host shrinks to fit and
        // the overlay's inset-0 lines up with the page exactly.
        if (host.firstChild !== canvas) host.replaceChildren(canvas);
      });

      if (animate && direction) {
        row.classList.remove('animate-page-in-next', 'animate-page-in-prev');
        // Force a reflow so the animation restarts on a repeated turn.
        void row.offsetWidth;
        row.classList.add(direction === 'prev' ? 'animate-page-in-prev' : 'animate-page-in-next');
      }
    };

    const cached = requests.map((request) => renderer.peek(request) ?? null);
    if (cached.every((canvas) => canvas !== null)) {
      mount(cached);
      setWaiting(false);
      return;
    }

    setWaiting(true);
    let cancelled = false;
    void Promise.all(requests.map((request) => renderer.request(request))).then((results) => {
      if (cancelled) return;
      mount(results);
      setWaiting(false);
    });

    return () => {
      cancelled = true;
    };
  }, [renderer, requests, animate, direction]);

  // Only admit to working if it takes long enough to notice; a normal turn
  // should never flash a spinner.
  useEffect(() => {
    if (!waiting) {
      setShowSpinner(false);
      return;
    }
    const timer = window.setTimeout(() => setShowSpinner(true), 250);
    return () => window.clearTimeout(timer);
  }, [waiting]);

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden">
      <div
        ref={rowRef}
        className="flex h-full w-full items-center justify-center"
        style={{ gap: `${SPREAD_GAP}px` }}
      >
        {requests.map((request) => {
          const key = requestKey(request);
          return (
            <div key={key} className="relative">
              <div
                ref={(node) => {
                  hosts.current.set(key, node);
                }}
                // Inversion applies to the score only — annotations sit above it
                // and must keep their real colours.
                className={cx(invert && 'score-inverted')}
              />
              {renderOverlay?.(request)}
            </div>
          );
        })}
      </div>
      {showSpinner ? (
        <div className="pointer-events-none absolute bottom-6 right-6">
          <Spinner className="h-8 w-8 text-moss-400" />
        </div>
      ) : null}
    </div>
  );
}
