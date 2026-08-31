import { useCallback, useEffect, useRef, useState } from 'react';
import type { Quad } from '../../types';

type CornerKey = keyof Quad;

const CORNERS: CornerKey[] = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'];

const CORNER_LABEL: Record<CornerKey, string> = {
  topLeft: 'Top left',
  topRight: 'Top right',
  bottomRight: 'Bottom right',
  bottomLeft: 'Bottom left',
};

/**
 * Four draggable corners over a photo, for telling the scanner where the page
 * is. Handles are 44px and sit outside the polygon's stroke so a fingertip does
 * not hide the corner it is placing.
 */
export default function QuadEditor({
  imageUrl,
  quad,
  onChange,
}: {
  imageUrl: string;
  quad: Quad;
  onChange: (next: Quad) => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<CornerKey | null>(null);
  const [active, setActive] = useState<CornerKey | null>(null);

  const moveCorner = useCallback(
    (corner: CornerKey, clientX: number, clientY: number) => {
      const frame = frameRef.current;
      if (!frame) return;
      const rect = frame.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      onChange({ ...quad, [corner]: [x, y] as [number, number] });
    },
    [quad, onChange],
  );

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!dragging.current) return;
      event.preventDefault();
      moveCorner(dragging.current, event.clientX, event.clientY);
    };
    const onUp = () => {
      dragging.current = null;
      setActive(null);
    };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [moveCorner]);

  const points = CORNERS.map((key) => quad[key]);
  const polygon = points.map(([x, y]) => `${x},${y}`).join(' ');
  // Outer rect plus the quad, filled even-odd, dims everything outside the page.
  const mask = `M0,0 H1 V1 H0 Z M${points.map(([x, y]) => `${x},${y}`).join(' L')} Z`;

  return (
    <div ref={frameRef} className="relative inline-block max-h-full touch-none select-none">
      <img
        src={imageUrl}
        alt="Captured page"
        className="block max-h-[60vh] w-auto max-w-full"
        draggable={false}
      />

      <svg
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0 h-full w-full"
      >
        <path d={mask} fillRule="evenodd" fill="rgba(8,9,10,0.62)" />
        <polygon
          points={polygon}
          fill="none"
          stroke="#4fbf5f"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      {CORNERS.map((key) => {
        const [x, y] = quad[key];
        return (
          <button
            key={key}
            type="button"
            aria-label={`${CORNER_LABEL[key]} corner`}
            onPointerDown={(event) => {
              event.preventDefault();
              dragging.current = key;
              setActive(key);
            }}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 0.02 : 0.005;
              const delta: Record<string, [number, number]> = {
                ArrowLeft: [-step, 0],
                ArrowRight: [step, 0],
                ArrowUp: [0, -step],
                ArrowDown: [0, step],
              };
              const move = delta[event.key];
              if (!move) return;
              event.preventDefault();
              onChange({
                ...quad,
                [key]: [
                  Math.max(0, Math.min(1, x + move[0])),
                  Math.max(0, Math.min(1, y + move[1])),
                ] as [number, number],
              });
            }}
            style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
            className="absolute -ml-6 -mt-6 flex h-12 w-12 items-center justify-center rounded-full"
          >
            <span
              className={
                'block rounded-full border-4 border-ink-950 bg-moss-400 shadow-lg transition-all ' +
                (active === key ? 'h-8 w-8' : 'h-6 w-6')
              }
            />
          </button>
        );
      })}
    </div>
  );
}
