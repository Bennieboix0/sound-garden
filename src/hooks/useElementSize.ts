import { useCallback, useEffect, useRef, useState } from 'react';

export interface Size {
  width: number;
  height: number;
}

/**
 * Tracks an element's content box. The performance view derives its render
 * scale from this, so it needs to survive rotation and the phone being plugged
 * into an external monitor mid-session.
 */
export function useElementSize<T extends HTMLElement>(): [
  (node: T | null) => void,
  Size,
] {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;

    const measure = () => {
      const rect = node.getBoundingClientRect();
      setSize((prev) =>
        // Sub-pixel jitter would otherwise invalidate the whole render cache.
        Math.abs(prev.width - rect.width) < 1 && Math.abs(prev.height - rect.height) < 1
          ? prev
          : { width: rect.width, height: rect.height },
      );
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    observer.current = ro;
  }, []);

  useEffect(() => () => observer.current?.disconnect(), []);

  return [ref, size];
}

/** Device pixel ratio, kept current when the window moves between displays. */
export function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() =>
    typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 3),
  );

  useEffect(() => {
    let query: MediaQueryList | null = null;
    const update = () => {
      setDpr(Math.min(window.devicePixelRatio || 1, 3));
      listen();
    };
    const listen = () => {
      query?.removeEventListener('change', update);
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      query.addEventListener('change', update);
    };
    listen();
    return () => query?.removeEventListener('change', update);
  }, []);

  return dpr;
}
