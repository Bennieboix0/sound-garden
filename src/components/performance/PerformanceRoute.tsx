import { useCallback, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import { hrefFor, silentReplace, type Route } from '../../state/router';
import type { Score } from '../../types';
import { Button, Spinner } from '../ui/controls';
import PerformanceView from './PerformanceView';

type PlayRoute = Extract<Route, { name: 'play' } | { name: 'perform' }>;

export default function PerformanceRoute({ route }: { route: PlayRoute }) {
  const setlistId = route.name === 'perform' ? route.setlistId : null;

  const setlist = useLiveQuery(
    async () => (setlistId ? ((await db.setlists.get(setlistId)) ?? null) : null),
    [setlistId],
  );

  const scoreIds = useMemo(() => {
    if (route.name === 'play') return [route.scoreId];
    return setlist?.scoreIds ?? [];
  }, [route, setlist]);

  const key = scoreIds.join(',');
  const scores = useLiveQuery(
    async () => {
      if (scoreIds.length === 0) return [] as Score[];
      const rows = await db.scores.bulkGet(scoreIds);
      // A setlist can outlive a deleted score; just skip the gaps.
      return rows.filter((row): row is Score => row !== undefined);
    },
    [key],
  );

  const exitHref =
    route.name === 'perform' && setlistId
      ? hrefFor({ name: 'setlist', id: setlistId })
      : hrefFor({ name: 'library' });

  const onExit = useCallback(() => {
    window.location.hash = exitHref;
  }, [exitHref]);

  const onPositionChange = useCallback(
    (index: number, page: number) => {
      if (route.name === 'perform' && setlistId) {
        silentReplace({ name: 'perform', setlistId, index });
      } else if (route.name === 'play') {
        silentReplace({ name: 'play', scoreId: route.scoreId, page });
      }
    },
    [route, setlistId],
  );

  const loading = scores === undefined || (setlistId !== null && setlist === undefined);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-black">
        <Spinner className="h-10 w-10 text-moss-400" />
      </div>
    );
  }

  if (scores.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 bg-ink-950 p-8 text-center text-ink-100">
        <p className="text-2xl font-bold">
          {setlistId ? 'This setlist has no playable scores.' : 'That score is not in your library.'}
        </p>
        <Button
          size="xl"
          variant="primary"
          onClick={() => {
            window.location.hash = exitHref;
          }}
        >
          Go back
        </Button>
      </div>
    );
  }

  return (
    <PerformanceView
      // Remount when the thing being played changes, so the page position
      // resets. Turning pages within one score or setlist keeps the same key,
      // and so keeps the view — and its warm page cache — mounted.
      key={setlistId ? `set:${setlistId}` : `score:${scoreIds[0]}`}
      scores={scores}
      startIndex={route.name === 'perform' ? route.index : 0}
      startPage={route.name === 'play' ? route.page : 1}
      setlistName={setlist?.name}
      onExit={onExit}
      onPositionChange={onPositionChange}
    />
  );
}
