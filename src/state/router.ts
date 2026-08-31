import { useMemo, useSyncExternalStore } from 'react';

export type Route =
  | { name: 'library' }
  | { name: 'setlists' }
  | { name: 'setlist'; id: string }
  | { name: 'settings' }
  /** Playing one score on its own. */
  | { name: 'play'; scoreId: string; page: number }
  /** Playing through a setlist, starting at `index`. */
  | { name: 'perform'; setlistId: string; index: number };

export function hrefFor(route: Route): string {
  switch (route.name) {
    case 'library':
      return '#/library';
    case 'setlists':
      return '#/setlists';
    case 'setlist':
      return `#/setlists/${encodeURIComponent(route.id)}`;
    case 'settings':
      return '#/settings';
    case 'play':
      return `#/play/${encodeURIComponent(route.scoreId)}/${route.page}`;
    case 'perform':
      return `#/perform/${encodeURIComponent(route.setlistId)}/${route.index}`;
  }
}

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/^\//, '');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);

  if (parts.length === 0) return { name: 'library' };

  switch (parts[0]) {
    case 'setlists':
      return parts[1] ? { name: 'setlist', id: parts[1] } : { name: 'setlists' };
    case 'settings':
      return { name: 'settings' };
    case 'play':
      if (!parts[1]) return { name: 'library' };
      return {
        name: 'play',
        scoreId: parts[1],
        page: Math.max(1, Number.parseInt(parts[2] ?? '1', 10) || 1),
      };
    case 'perform':
      if (!parts[1]) return { name: 'setlists' };
      return {
        name: 'perform',
        setlistId: parts[1],
        index: Math.max(0, Number.parseInt(parts[2] ?? '0', 10) || 0),
      };
    case 'library':
    default:
      return { name: 'library' };
  }
}

export function navigate(route: Route, replace = false): void {
  const href = hrefFor(route);
  if (window.location.hash === href) return;
  if (replace) {
    window.history.replaceState(null, '', href);
    // replaceState does not fire hashchange, so tell our subscribers directly.
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = href;
  }
}

/**
 * Updates the address bar without telling React. Used by the performance view
 * to record the current page as you play, so a reload resumes in the right
 * place — without a re-render on every page turn.
 */
export function silentReplace(route: Route): void {
  const href = hrefFor(route);
  if (window.location.hash === href) return;
  window.history.replaceState(null, '', href);
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

function getSnapshot(): string {
  return window.location.hash || '#/library';
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // Memoised so the route object is referentially stable between renders and
  // is safe to use as an effect dependency.
  return useMemo(() => parseHash(hash), [hash]);
}
