import { useCallback, useEffect, useRef, useState } from 'react';
import { newId } from '../../db/db';
import { importPdf } from '../../db/importScores';
import { parseTags } from '../library/useLibrary';
import { DEFAULT_QUAD, analysisImageData, detectPageQuad } from '../../scan/detect';
import { enhance, imageDataToCanvas, packOneBit } from '../../scan/enhance';
import { canvasToJpegBytes, imagesToPdf, type PdfImagePage } from '../../scan/pdf';
import { useCamera } from '../../scan/useCamera';
import { warpQuad } from '../../scan/warp';
import type { Quad, ScanMode } from '../../types';
import { Button, Field, SegmentedControl, Spinner, TextField, cx } from '../ui/controls';
import QuadEditor from './QuadEditor';

type Stage = 'source' | 'adjust' | 'review';

interface PendingShot {
  url: string;
  bitmap: ImageBitmap;
  width: number;
  height: number;
  quad: Quad;
  autoDetected: boolean;
}

interface AcceptedPage {
  id: string;
  page: PdfImagePage;
  thumbUrl: string;
}

const MODE_OPTIONS: { value: ScanMode; label: string }[] = [
  { value: 'bw', label: 'Black & white' },
  { value: 'grey', label: 'Greyscale' },
  { value: 'colour', label: 'Colour' },
];

export default function ScannerView({ onClose }: { onClose: () => void }) {
  const camera = useCamera();
  const [stage, setStage] = useState<Stage>('source');
  const [shot, setShot] = useState<PendingShot | null>(null);
  const [mode, setMode] = useState<ScanMode>('bw');
  const [pages, setPages] = useState<AcceptedPage[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [tags, setTags] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  // Object URLs are revoked as pages are discarded, but sweep on unmount too.
  const urls = useRef(new Set<string>());
  const trackUrl = (url: string) => {
    urls.current.add(url);
    return url;
  };
  useEffect(() => {
    const held = urls.current;
    return () => {
      for (const url of held) URL.revokeObjectURL(url);
      held.clear();
    };
  }, []);

  const beginAdjust = useCallback(async (blob: Blob) => {
    setError(null);
    setBusy('Reading photo');
    try {
      const bitmap = await createImageBitmap(blob);
      const analysis = analysisImageData(bitmap);
      const detected = analysis ? detectPageQuad(analysis) : null;
      setShot({
        url: trackUrl(URL.createObjectURL(blob)),
        bitmap,
        width: bitmap.width,
        height: bitmap.height,
        quad: detected ?? DEFAULT_QUAD,
        autoDetected: detected !== null,
      });
      setStage('adjust');
    } catch (err) {
      console.error('[sound-garden] could not read capture', err);
      setError('That image could not be read.');
    } finally {
      setBusy(null);
    }
  }, []);

  const takePhoto = useCallback(async () => {
    const canvas = camera.capture();
    if (!canvas) {
      setError('The camera is not ready yet.');
      return;
    }
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.95),
    );
    if (blob) await beginAdjust(blob);
  }, [camera, beginAdjust]);

  const [queue, setQueue] = useState<File[]>([]);

  const acceptPage = useCallback(async () => {
    if (!shot) return;
    setBusy('Straightening page');
    setError(null);
    try {
      // Yield a frame so the spinner paints before the warp blocks the thread.
      await new Promise((resolve) => setTimeout(resolve, 16));
      const warped = warpQuad(shot.bitmap, shot.quad, shot.width, shot.height);
      if (!warped) throw new Error('Those corners do not make a page.');

      const processed = enhance(warped.image, mode);
      const canvas = imageDataToCanvas(processed);

      const page: PdfImagePage =
        mode === 'bw'
          ? (() => {
              const packed = packOneBit(processed);
              return {
                kind: 'bitonal',
                width: packed.width,
                height: packed.height,
                data: packed.bytes,
              };
            })()
          : {
              kind: 'jpeg',
              width: processed.width,
              height: processed.height,
              data: await canvasToJpegBytes(canvas),
            };

      // Small preview for the review strip; the full canvas is not retained.
      const thumb = document.createElement('canvas');
      const scale = 200 / Math.max(canvas.width, canvas.height);
      thumb.width = Math.max(1, Math.round(canvas.width * scale));
      thumb.height = Math.max(1, Math.round(canvas.height * scale));
      thumb.getContext('2d')?.drawImage(canvas, 0, 0, thumb.width, thumb.height);
      const thumbBlob = await new Promise<Blob | null>((resolve) =>
        thumb.toBlob(resolve, 'image/webp', 0.8),
      );

      setPages((current) => [
        ...current,
        {
          id: newId(),
          page,
          thumbUrl: thumbBlob ? trackUrl(URL.createObjectURL(thumbBlob)) : '',
        },
      ]);

      shot.bitmap.close();
      URL.revokeObjectURL(shot.url);
      urls.current.delete(shot.url);
      setShot(null);

      // Straight on to the next queued photo, if the user picked several.
      const [next, ...rest] = queue;
      if (next) {
        setQueue(rest);
        await beginAdjust(next);
      } else {
        setStage('review');
      }
    } catch (err) {
      console.error('[sound-garden] page processing failed', err);
      setError(err instanceof Error ? err.message : 'That page could not be processed.');
    } finally {
      setBusy(null);
    }
  }, [shot, mode, queue, beginAdjust]);

  const discardShot = useCallback(() => {
    if (shot) {
      shot.bitmap.close();
      URL.revokeObjectURL(shot.url);
      urls.current.delete(shot.url);
    }
    setShot(null);
    const [next, ...rest] = queue;
    if (next) {
      setQueue(rest);
      void beginAdjust(next);
    } else {
      setStage(pages.length > 0 ? 'review' : 'source');
    }
  }, [shot, queue, pages.length, beginAdjust]);

  const save = useCallback(async () => {
    if (pages.length === 0) return;
    setBusy('Building PDF');
    setError(null);
    try {
      const name = title.trim() || 'Scanned score';
      const blob = imagesToPdf(
        pages.map((p) => p.page),
        { title: name, author: artist.trim() || undefined },
      );
      await importPdf(blob, `${name}.pdf`, {
        title: name,
        artist: artist.trim(),
        tags: parseTags(tags),
        // Corners were already placed by hand; a second automatic trim would
        // only fight that decision.
        autoCrop: false,
      });
      camera.stop();
      onClose();
    } catch (err) {
      console.error('[sound-garden] could not save scan', err);
      setError(err instanceof Error ? err.message : 'The scan could not be saved.');
    } finally {
      setBusy(null);
    }
  }, [pages, title, artist, tags, camera, onClose]);

  const close = () => {
    camera.stop();
    onClose();
  };

  const onFilesPicked = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) {
      setError('Those files are not images.');
      return;
    }
    const [first, ...rest] = images;
    setQueue(rest);
    await beginAdjust(first);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink-950 text-ink-100">
      <header className="flex shrink-0 items-center gap-3 border-b-2 border-ink-700 px-4 py-3 pad-safe-top">
        <div className="mr-auto min-w-0">
          <h2 className="truncate text-xl font-bold">Scan a score</h2>
          <p className="truncate text-base text-ink-300">
            {stage === 'source' && 'Photograph each page, or import photos you already have'}
            {stage === 'adjust' && (shot?.autoDetected
              ? 'Page edges found — drag a corner if any are off'
              : 'Drag the corners onto the page')}
            {stage === 'review' && `${pages.length} ${pages.length === 1 ? 'page' : 'pages'} ready`}
          </p>
        </div>
        <Button size="lg" onClick={close}>
          Cancel
        </Button>
      </header>

      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        // On a phone this opens the camera app directly, which is the fallback
        // when getUserMedia is unavailable.
        capture="environment"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          void onFilesPicked(files);
        }}
      />

      <div
        className={cx(
          'relative flex min-h-0 flex-1 flex-col items-center p-4',
          // The review list grows downwards; the capture and adjust steps are
          // single objects that read better centred.
          stage === 'review' ? 'justify-start overflow-y-auto' : 'justify-center',
        )}
      >
        {error ? (
          <p className="mb-3 rounded-xl border-2 border-amber-400 bg-amber-400/10 px-4 py-3 text-center text-lg font-semibold">
            {error}
          </p>
        ) : null}

        {stage === 'source' ? (
          <div className="flex w-full max-w-2xl flex-col items-center gap-4">
            <div className="relative w-full overflow-hidden rounded-2xl border-2 border-ink-700 bg-black">
              <video
                ref={camera.videoRef}
                playsInline
                muted
                className={cx(
                  'block max-h-[52vh] w-full object-contain',
                  camera.status === 'live' ? '' : 'hidden',
                )}
              />
              {camera.status !== 'live' ? (
                <div className="flex min-h-[38vh] flex-col items-center justify-center gap-4 p-6 text-center">
                  {camera.status === 'starting' ? (
                    <Spinner className="h-10 w-10 text-moss-400" />
                  ) : (
                    <>
                      <p className="text-lg font-semibold text-ink-200">
                        {camera.message ?? 'Use the camera to photograph each page.'}
                      </p>
                      {camera.status === 'idle' ? (
                        <Button size="xl" variant="primary" onClick={camera.start}>
                          Start camera
                        </Button>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center justify-center gap-3">
              {camera.status === 'live' ? (
                <Button size="xl" variant="primary" className="px-10" onClick={() => void takePhoto()}>
                  Capture page
                </Button>
              ) : null}
              <Button size="xl" onClick={() => fileInput.current?.click()}>
                Import photos
              </Button>
              {pages.length > 0 ? (
                <Button size="xl" onClick={() => setStage('review')}>
                  Review {pages.length}
                </Button>
              ) : null}
            </div>
            <p className="max-w-lg text-center text-base text-ink-300">
              Lay the page flat on a surface that contrasts with the paper. The whole sheet should
              be in frame — the corners get straightened out afterwards.
            </p>
          </div>
        ) : null}

        {stage === 'adjust' && shot ? (
          <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-4">
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <QuadEditor
                imageUrl={shot.url}
                quad={shot.quad}
                onChange={(quad) => setShot((current) => (current ? { ...current, quad } : current))}
              />
            </div>
            <SegmentedControl<ScanMode>
              ariaLabel="Processing mode"
              tone="onDark"
              size="lg"
              value={mode}
              onChange={setMode}
              options={MODE_OPTIONS}
            />
          </div>
        ) : null}

        {stage === 'review' ? (
          <div className="flex w-full max-w-3xl flex-col gap-4 overflow-y-auto">
            {pages.length === 0 ? (
              <p className="py-10 text-center text-lg text-ink-300">No pages captured yet.</p>
            ) : (
              <ul className="grid grid-cols-3 gap-3 sm:grid-cols-5">
                {pages.map((page, index) => (
                  <li
                    key={page.id}
                    className="relative overflow-hidden rounded-xl border-2 border-ink-700 bg-white"
                  >
                    {page.thumbUrl ? (
                      <img src={page.thumbUrl} alt={`Page ${index + 1}`} className="block w-full" />
                    ) : null}
                    <span className="absolute left-1 top-1 rounded bg-ink-950/85 px-2 text-sm font-bold text-white">
                      {index + 1}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove page ${index + 1}`}
                      onClick={() =>
                        setPages((current) => current.filter((p) => p.id !== page.id))
                      }
                      className="absolute right-1 top-1 flex h-9 w-9 items-center justify-center rounded-lg bg-ink-950/85 text-lg font-bold text-red-300"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Title">
                <TextField
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Scanned score"
                />
              </Field>
              <Field label="Composer or artist">
                <TextField value={artist} onChange={(event) => setArtist(event.target.value)} />
              </Field>
            </div>
            <Field label="Tags" hint="Comma separated.">
              <TextField value={tags} onChange={(event) => setTags(event.target.value)} />
            </Field>
          </div>
        ) : null}

        {busy ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-ink-950/85">
            <Spinner className="h-12 w-12 text-moss-400" />
            <p className="text-xl font-bold">{busy}…</p>
          </div>
        ) : null}
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-center gap-3 border-t-2 border-ink-700 px-4 py-3 pad-safe-bottom">
        {stage === 'adjust' ? (
          <>
            <Button size="xl" onClick={discardShot} disabled={busy !== null}>
              Discard
            </Button>
            <Button size="xl" variant="primary" className="px-10" onClick={() => void acceptPage()} disabled={busy !== null}>
              Use this page
            </Button>
          </>
        ) : null}

        {stage === 'review' ? (
          <>
            <Button size="xl" onClick={() => setStage('source')} disabled={busy !== null}>
              Add another page
            </Button>
            <Button
              size="xl"
              variant="primary"
              className="px-10"
              onClick={() => void save()}
              disabled={busy !== null || pages.length === 0}
            >
              Save to library
            </Button>
          </>
        ) : null}
      </footer>
    </div>
  );
}
