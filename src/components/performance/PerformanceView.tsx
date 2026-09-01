import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { db } from '../../db/db';
import { clearPage, undoLastStroke, useEnsembleLayersFor, usePageStrokes } from '../../db/annotations';
import { useEnsembles } from '../../sync/ensembleClient';
import { usePageFollow } from '../../sync/usePageFollow';
import { getTransport } from '../../sync/useSync';
import FollowBadge from './FollowBadge';
import { useElementSize, useDevicePixelRatio } from '../../hooks/useElementSize';
import { useIdleUI } from '../../hooks/useIdleUI';
import { usePedal } from '../../hooks/usePedal';
import { useWakeLock } from '../../hooks/useWakeLock';
import { syncClient } from '../../sync/client';
import { useSuspendSyncWhilePlaying } from '../../sync/useSync';
import { PageRenderer, type PageRequest } from '../../pdf/render';
import { useSettings } from '../../state/SettingsProvider';
import type { FitMode, PedalAction, Score } from '../../types';
import { NO_CROP } from '../../types';
import { Button, SegmentedControl, cx } from '../ui/controls';
import AnnotationLayer, { type PenSettings } from './AnnotationLayer';
import AnnotationBar, { PEN_COLOURS } from './AnnotationBar';
import CropTool from './CropTool';
import PageSurface, { SPREAD_GAP, type TurnDirection } from './PageSurface';

/**
 * One renderer for the whole app. It is cleared, not destroyed, when the
 * performance view closes, which keeps it safe under React strict mode's
 * double-invoked effects.
 */
const renderer = new PageRenderer();

/** Highest page a spread can start on without leaving a gap before the end. */
function lastStartPage(pageCount: number, spread: boolean): number {
  if (pageCount <= 1) return 1;
  return spread ? Math.max(1, pageCount - ((pageCount - 1) % 2)) : pageCount;
}

export interface PerformanceViewProps {
  scores: Score[];
  startIndex: number;
  startPage: number;
  setlistName?: string;
  onExit: () => void;
  onPositionChange: (index: number, page: number) => void;
}

export default function PerformanceView({
  scores,
  startIndex,
  startPage,
  setlistName,
  onExit,
  onPositionChange,
}: PerformanceViewProps) {
  const { settings } = useSettings();
  const [containerRef, size] = useElementSize<HTMLDivElement>();
  const dpr = useDevicePixelRatio();
  const ui = useIdleUI(3000);
  const [cropping, setCropping] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  const [pen, setPen] = useState<PenSettings>({
    tool: 'pen',
    color: PEN_COLOURS.pen[0],
    width: 0.004,
  });
  /** Which page undo and clear act on when a spread is showing. */
  const [lastMarkedPage, setLastMarkedPage] = useState<number | null>(null);
  /** Published layers the reader has switched off for this session. */
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(new Set());
  /** Set when the director is on a score this device does not hold. */
  const [missingScore, setMissingScore] = useState<string | null>(null);

  const scoresRef = useRef(scores);
  scoresRef.current = scores;

  const follow = usePageFollow({
    transport: getTransport(),
    onFollowPage: (contentHash, targetPage) => {
      const at = scoresRef.current.findIndex((score) => score.contentHash === contentHash);
      if (at === -1) {
        // We do not have this score, and we never go looking: the file is not
        // something the server has, or is allowed to have.
        setMissingScore(contentHash);
        return;
      }
      setMissingScore(null);
      setDirection('next');
      setPos({ index: at, page: Math.max(1, targetPage) });
    },
  });

  useWakeLock(settings.keepScreenAwake);
  // Nothing may contend with a page turn. Sync resumes on the way out.
  useSuspendSyncWhilePlaying(true);

  const [pos, setPos] = useState(() => ({
    index: Math.min(Math.max(0, startIndex), Math.max(0, scores.length - 1)),
    page: Math.max(1, startPage),
  }));
  const [direction, setDirection] = useState<TurnDirection>(null);
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);

  const index = Math.min(pos.index, Math.max(0, scores.length - 1));
  const current: Score | undefined = scores[index];
  const pageCount = current?.pageCount ?? 1;
  const fitMode: FitMode = current?.fitMode ?? settings.defaultFitMode;
  const spread = current?.spread ?? settings.defaultSpread;
  const step = spread ? 2 : 1;
  const page = Math.min(Math.max(1, pos.page), Math.max(1, pageCount));

  const flash = useCallback((text: string) => {
    setToast({ id: Date.now() + Math.random(), text });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Record where we are, so a reload or a crash resumes on the same page.
  useEffect(() => {
    onPositionChange(index, page);
  }, [onPositionChange, index, page]);

  // Free the page cache when leaving; a whole setlist's worth of rendered
  // pages has no business sitting in memory while browsing the library.
  useEffect(() => () => renderer.clear(), []);

  const positionLabel = useMemo(() => {
    if (!current) return '';
    if (scores.length > 1) return `${index + 1} of ${scores.length} · ${current.title}`;
    return current.title;
  }, [current, index, scores.length]);

  // Announce the piece on entry and on every setlist transition.
  const announcedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!current) return;
    const token = `${index}:${current.id}`;
    if (announcedFor.current === token) return;
    announcedFor.current = token;
    flash(positionLabel);
  }, [current, index, positionLabel, flash]);

  const buildRequests = useCallback(
    (scoreIndex: number, from: number): PageRequest[] => {
      const score = scores[scoreIndex];
      if (!score || size.width === 0 || size.height === 0) return [];
      const useSpread = score.spread ?? settings.defaultSpread;
      const mode = score.fitMode ?? settings.defaultFitMode;
      const width = useSpread ? Math.max(1, (size.width - SPREAD_GAP) / 2) : size.width;
      const pages = useSpread ? [from, from + 1] : [from];
      return pages
        .filter((n) => n >= 1 && n <= score.pageCount)
        .map((pageNumber) => ({
          scoreId: score.id,
          pageNumber,
          crop: score.crop ?? NO_CROP,
          fitMode: mode,
          availWidth: width,
          availHeight: size.height,
          dpr,
        }));
    },
    [scores, settings.defaultSpread, settings.defaultFitMode, size.width, size.height, dpr],
  );

  const requests = useMemo(
    () => buildRequests(index, page),
    [buildRequests, index, page],
  );

  // In a spread, undo and clear follow whichever page was drawn on last, so
  // long as it is still on screen. Computed above the early return below so the
  // strokes hook is never called conditionally.
  const pagesOnScreen = requests.map((request) => request.pageNumber);
  const markTarget =
    lastMarkedPage !== null && pagesOnScreen.includes(lastMarkedPage) ? lastMarkedPage : page;
  const ensembles = useEnsembles();
  const layersHere = useEnsembleLayersFor(current?.contentHash);
  const visibleLayers = useMemo(
    () => new Set(layersHere.filter((id) => !hiddenLayers.has(id))),
    [layersHere, hiddenLayers],
  );
  const markTargetStrokes = usePageStrokes(current?.contentHash, markTarget, visibleLayers);

  // Director side: broadcast wherever we are. Coalesced inside the hook, and
  // never awaited, so this cannot delay the director's own turn.
  useEffect(() => {
    if (follow.state !== 'leading' || !current) return;
    follow.report(current.contentHash, page, current.title);
  }, [follow, current, page]);

  // Warm the neighbours, including the first page of the next piece so that a
  // setlist transition costs no more than a page turn inside a piece.
  useEffect(() => {
    if (requests.length === 0) return;
    const ahead = buildRequests(index, page + step);
    const behind = buildRequests(index, page - step);
    const nextPiece =
      page + step > pageCount && index + 1 < scores.length ? buildRequests(index + 1, 1) : [];
    renderer.prefetch([...ahead, ...nextPiece, ...behind]);
    // `ahead` already covers the follow case: the director's next call is
    // almost always the following page, so a follow jump lands on a cache hit
    // and swaps synchronously, exactly like a pedal turn.
  }, [requests, buildRequests, index, page, step, pageCount, scores.length]);

  const goNext = useCallback(() => {
    // Any local intent takes control, before the move. Instant and silent.
    follow.takeControl();
    setDirection('next');
    setPos((current_) => {
      const at = Math.min(current_.index, Math.max(0, scores.length - 1));
      const score = scores[at];
      if (!score) return current_;
      const useSpread = score.spread ?? settings.defaultSpread;
      const by = useSpread ? 2 : 1;
      const nextPage = Math.min(Math.max(1, current_.page), score.pageCount) + by;
      if (nextPage <= score.pageCount) return { index: at, page: nextPage };
      if (at + 1 < scores.length) return { index: at + 1, page: 1 };
      flash('End of set');
      return current_;
    });
  }, [scores, settings.defaultSpread, flash, follow]);

  const goPrev = useCallback(() => {
    follow.takeControl();
    setDirection('prev');
    setPos((current_) => {
      const at = Math.min(current_.index, Math.max(0, scores.length - 1));
      const score = scores[at];
      if (!score) return current_;
      const useSpread = score.spread ?? settings.defaultSpread;
      const by = useSpread ? 2 : 1;
      const prevPage = Math.min(Math.max(1, current_.page), score.pageCount) - by;
      if (prevPage >= 1) return { index: at, page: prevPage };
      if (at > 0) {
        const previous = scores[at - 1];
        const prevSpread = previous.spread ?? settings.defaultSpread;
        return { index: at - 1, page: lastStartPage(previous.pageCount, prevSpread) };
      }
      flash('Start of set');
      return current_;
    });
  }, [scores, settings.defaultSpread, flash, follow]);

  const onPedal = useCallback(
    (action: PedalAction) => {
      if (action === 'next') goNext();
      else goPrev();
    },
    [goNext, goPrev],
  );

  usePedal({
    // The crop tool takes the keyboard while it is open.
    enabled: !cropping,
    bindings: settings.pedalBindings,
    debounceMs: settings.debounceMs,
    onAction: onPedal,
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (cropping) setCropping(false);
      else if (annotating) setAnnotating(false);
      else onExit();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cropping, annotating, onExit]);

  const setFitMode = (mode: FitMode) => {
    if (current) void db.scores.update(current.id, { fitMode: mode });
  };
  const setSpread = (value: boolean) => {
    if (!current) return;
    void db.scores.update(current.id, { spread: value });
    // Spreads start on odd pages, so land on the spread containing this page.
    if (value && page % 2 === 0) setPos((p) => ({ ...p, page: Math.max(1, page - 1) }));
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  };

  const handleZoneTap = (zone: 'left' | 'middle' | 'right') => {
    if (!settings.tapZones) {
      ui.toggle();
      return;
    }
    if (zone === 'left') goPrev();
    else if (zone === 'right') goNext();
    else ui.toggle();
  };

  if (!current) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 bg-ink-950 p-8 text-center text-ink-100">
        <p className="text-2xl font-bold">This score is no longer in your library.</p>
        <Button size="xl" variant="primary" onClick={onExit}>
          Back to library
        </Button>
      </div>
    );
  }

  const invert = settings.darkMode && settings.invertScores;
  const lastPageOnScreen = spread ? Math.min(page + 1, pageCount) : page;

  return (
    <div className="relative h-full w-full overflow-hidden bg-black no-select">
      <div ref={containerRef} className="absolute inset-0">
        <PageSurface
          renderer={renderer}
          requests={requests}
          invert={invert}
          animate={settings.pageAnimation}
          direction={direction}
          renderOverlay={(request) => (
            <AnnotationLayer
              contentHash={
                scores.find((score) => score.id === request.scoreId)?.contentHash ?? ''
              }
              pageNumber={request.pageNumber}
              crop={request.crop}
              editing={annotating}
              pen={pen}
              visibleEnsembles={visibleLayers}
              onStrokeAdded={(page) => {
                setLastMarkedPage(page);
                // Debounced: fires 5s after the hand stops, and still only once
                // the performance view has been left.
                syncClient.noteLocalChange();
              }}
            />
          )}
        />
      </div>

      {/* Tap zones sit under the chrome but over the score. Suppressed while
          annotating, where a tap is a pen stroke rather than a page turn. */}
      <div className={cx('absolute inset-0 z-10 flex', annotating && 'hidden')}>
        <button
          type="button"
          aria-label="Previous page"
          className="h-full w-1/3 cursor-w-resize focus:outline-none"
          onClick={() => handleZoneTap('left')}
        />
        <button
          type="button"
          aria-label="Show or hide controls"
          className="h-full w-1/3 focus:outline-none"
          onClick={() => handleZoneTap('middle')}
        />
        <button
          type="button"
          aria-label="Next page"
          className="h-full w-1/3 cursor-e-resize focus:outline-none"
          onClick={() => handleZoneTap('right')}
        />
      </div>

      <FollowBadge
        follow={follow}
        ensembles={ensembles}
        missingTitle={
          missingScore && follow.lastPosition?.contentHash === missingScore
            ? follow.lastPosition.title
            : null
        }
      />

      {/* Position toast. Shows on transitions even while the chrome is hidden. */}
      {toast ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-10 z-30 flex justify-center px-6">
          <p
            key={toast.id}
            role="status"
            className="animate-toast-in max-w-full truncate rounded-2xl bg-ink-950/90 px-6 py-3 text-2xl font-bold text-white shadow-2xl ring-2 ring-moss-400"
          >
            {toast.text}
          </p>
        </div>
      ) : null}

      {/* Chrome. Overlaid, so showing it never reflows or re-renders the score. */}
      <div
        className={cx(
          'pointer-events-none absolute inset-0 z-20 flex flex-col justify-between transition-opacity duration-200',
          ui.visible ? 'opacity-100' : 'opacity-0',
        )}
        aria-hidden={!ui.visible}
      >
        <header
          className={cx(
            'flex items-start gap-3 border-b-2 border-ink-700 bg-ink-950/95 px-4 pb-3 pt-3 backdrop-blur-sm pad-safe-top',
            ui.visible && 'pointer-events-auto',
          )}
        >
          <Button size="xl" onClick={onExit} className="!border-ink-500 !bg-ink-800 !text-white">
            ‹ Library
          </Button>
          <div className="min-w-0 flex-1 pt-1 text-center">
            <p className="truncate text-2xl font-bold text-white">{current.title}</p>
            <p className="truncate text-lg font-semibold text-ink-100">
              {[current.artist, current.key, current.tempo].filter(Boolean).join(' · ')}
            </p>
          </div>
          <div className="shrink-0 rounded-xl bg-ink-900/90 px-4 py-2 text-right ring-1 ring-ink-600">
            <p className="text-xl font-bold text-white">
              {spread && lastPageOnScreen !== page
                ? `${page}–${lastPageOnScreen}`
                : page}
              <span className="text-ink-300"> / {pageCount}</span>
            </p>
            {setlistName ? (
              <p className="truncate text-sm font-semibold text-moss-300">
                {setlistName} · {index + 1} of {scores.length}
              </p>
            ) : null}
          </div>
        </header>

        {/* Prev and Next are pinned to the outer edges and never wrap: they are
            the two controls used mid-song, so they must stay where the hand
            expects them however narrow the screen gets. */}
        {annotating ? null : (
        <footer
          className={cx(
            'flex items-center gap-3 border-t-2 border-ink-700 bg-ink-950/95 px-4 pb-3 pt-3 backdrop-blur-sm pad-safe-bottom',
            ui.visible && 'pointer-events-auto',
          )}
        >
          <Button
            size="xl"
            onClick={goPrev}
            className="!border-ink-500 !bg-ink-800 !text-white shrink-0 px-6"
          >
            ◀ Prev
          </Button>

          <div className="flex flex-1 flex-wrap items-center justify-center gap-3">
          <SegmentedControl<FitMode>
            ariaLabel="Fit mode"
            tone="onDark"
            size="lg"
            value={fitMode}
            onChange={setFitMode}
            options={[
              { value: 'width', label: 'Fit width' },
              { value: 'page', label: 'Fit page' },
            ]}
          />

          <SegmentedControl<'single' | 'spread'>
            ariaLabel="Page layout"
            tone="onDark"
            size="lg"
            value={spread ? 'spread' : 'single'}
            onChange={(value) => setSpread(value === 'spread')}
            options={[
              { value: 'single', label: '1 page' },
              { value: 'spread', label: '2 pages' },
            ]}
          />

          {follow.state === 'off'
            ? ensembles.map((ensemble) => (
                <Button
                  key={`follow-${ensemble.id}`}
                  size="lg"
                  onClick={() => follow.start(ensemble.id, ensemble.role)}
                  className="!border-ink-500 !bg-ink-800 !text-white"
                  title={
                    ensemble.role === 'director'
                      ? `Broadcast your page to ${ensemble.name}`
                      : `Follow the director of ${ensemble.name}`
                  }
                >
                  {ensemble.role === 'director' ? 'Lead ' : 'Follow '}
                  {ensemble.name}
                </Button>
              ))
            : null}
          {layersHere.map((ensembleId) => {
            const name = ensembles.find((e) => e.id === ensembleId)?.name ?? 'Ensemble';
            const shown = !hiddenLayers.has(ensembleId);
            return (
              <Button
                key={ensembleId}
                size="lg"
                aria-pressed={shown}
                onClick={() =>
                  setHiddenLayers((current_) => {
                    const next = new Set(current_);
                    if (next.has(ensembleId)) next.delete(ensembleId);
                    else next.add(ensembleId);
                    return next;
                  })
                }
                className={
                  shown
                    ? '!border-moss-400 !bg-moss-500 !text-white'
                    : '!border-ink-500 !bg-ink-800 !text-ink-300'
                }
                title={`Show or hide markings published by ${name}`}
              >
                {shown ? '● ' : '○ '}
                {name}
              </Button>
            );
          })}
          <Button
            size="lg"
            onClick={() => {
              // Drawing is a local activity; it takes the device out of follow.
              follow.takeControl();
              setAnnotating(true);
              ui.hide();
            }}
            className="!border-ink-500 !bg-ink-800 !text-white"
          >
            Annotate
          </Button>
          <Button
            size="lg"
            onClick={() => setCropping(true)}
            className="!border-ink-500 !bg-ink-800 !text-white"
          >
            Crop
          </Button>
          <Button
            size="lg"
            onClick={toggleFullscreen}
            className="!border-ink-500 !bg-ink-800 !text-white"
          >
            Full screen
          </Button>
          </div>

          <Button
            size="xl"
            onClick={goNext}
            className="!border-ink-500 !bg-ink-800 !text-white shrink-0 px-6"
          >
            Next ▶
          </Button>
        </footer>
        )}
      </div>

      {/* The marking bar never auto-hides — you are looking at it, not past it. */}
      {annotating ? (
        <div className="absolute inset-x-0 bottom-0 z-30">
          <AnnotationBar
            pen={pen}
            onChange={setPen}
            canUndo={markTargetStrokes.length > 0}
            pageLabel={`page ${markTarget}`}
            onUndo={() => void undoLastStroke(current.contentHash, markTarget)}
            onClearPage={() => void clearPage(current.contentHash, markTarget)}
            onDone={() => setAnnotating(false)}
          />
        </div>
      ) : null}

      {cropping ? (
        <CropTool score={current} pageNumber={page} onClose={() => setCropping(false)} />
      ) : null}
    </div>
  );
}
