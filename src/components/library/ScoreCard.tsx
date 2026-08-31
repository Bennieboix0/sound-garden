import { hrefFor } from '../../state/router';
import type { Score } from '../../types';
import { Button, cx } from '../ui/controls';
import ScoreMenu from './ScoreMenu';

export function ThumbnailImage({
  thumbnail,
  title,
  invert,
  className,
}: {
  thumbnail?: string;
  title: string;
  invert: boolean;
  className?: string;
}) {
  if (!thumbnail) {
    return (
      <div
        className={cx(
          'flex items-center justify-center bg-ink-200 text-ink-600 dark:bg-ink-800 dark:text-ink-300',
          className,
        )}
      >
        <span className="text-3xl" aria-hidden>
          ♪
        </span>
      </div>
    );
  }
  return (
    <img
      src={thumbnail}
      alt={`First page of ${title}`}
      loading="lazy"
      className={cx('bg-white object-contain', invert && 'score-inverted', className)}
    />
  );
}

export function PageBadge({ count }: { count: number }) {
  return (
    <span className="rounded-md bg-ink-800 px-2 py-0.5 text-sm font-bold text-white dark:bg-ink-700">
      {count} {count === 1 ? 'page' : 'pages'}
    </span>
  );
}

export default function ScoreCard({
  score,
  thumbnail,
  invert,
  onEdit,
  onDelete,
  onAddToSetlist,
}: {
  score: Score;
  thumbnail?: string;
  invert: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onAddToSetlist: () => void;
}) {
  return (
    <li className="flex flex-col overflow-hidden rounded-2xl border-2 border-ink-300 bg-white dark:border-ink-700 dark:bg-ink-850">
      <a
        href={hrefFor({ name: 'play', scoreId: score.id, page: 1 })}
        className="group relative block aspect-[1/1.414] overflow-hidden bg-white"
        aria-label={`Play ${score.title}`}
      >
        <ThumbnailImage
          thumbnail={thumbnail}
          title={score.title}
          invert={invert}
          className="h-full w-full"
        />
        <span className="absolute inset-x-0 bottom-0 flex justify-end p-2">
          <PageBadge count={score.pageCount} />
        </span>
      </a>

      <div className="flex min-w-0 flex-1 flex-col gap-1 p-3">
        <a
          href={hrefFor({ name: 'play', scoreId: score.id, page: 1 })}
          className="line-clamp-2 rounded text-lg font-bold leading-tight hover:underline"
        >
          {score.title}
        </a>
        {score.artist ? (
          <p className="line-clamp-1 text-base text-ink-700 dark:text-ink-200">{score.artist}</p>
        ) : null}
        <p className="text-sm font-medium text-ink-600 dark:text-ink-300">
          {[score.key, score.tempo].filter(Boolean).join(' · ')}
        </p>

        <div className="mt-auto flex items-center gap-2 pt-2">
          <Button
            variant="primary"
            className="flex-1"
            onClick={() => {
              window.location.hash = hrefFor({ name: 'play', scoreId: score.id, page: 1 });
            }}
          >
            Play
          </Button>
          <ScoreMenu onEdit={onEdit} onDelete={onDelete} onAddToSetlist={onAddToSetlist} />
        </div>
      </div>
    </li>
  );
}
