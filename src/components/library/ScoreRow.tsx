import { hrefFor } from '../../state/router';
import type { Score } from '../../types';
import { Button } from '../ui/controls';
import ScoreMenu from './ScoreMenu';
import { PageBadge, ThumbnailImage } from './ScoreCard';
import { formatBytes } from './useLibrary';

export default function ScoreRow({
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
  const href = hrefFor({ name: 'play', scoreId: score.id, page: 1 });

  return (
    <li className="flex items-center gap-3 rounded-xl border-2 border-ink-300 bg-white p-2 dark:border-ink-700 dark:bg-ink-850">
      <a href={href} className="shrink-0" aria-label={`Play ${score.title}`}>
        <ThumbnailImage
          thumbnail={thumbnail}
          title={score.title}
          invert={invert}
          className="h-20 w-[3.55rem] rounded-md border border-ink-300 object-cover dark:border-ink-700"
        />
      </a>

      <div className="min-w-0 flex-1">
        <a href={href} className="block truncate rounded text-lg font-bold hover:underline">
          {score.title}
        </a>
        <p className="truncate text-base text-ink-700 dark:text-ink-200">
          {score.artist || 'Unknown artist'}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <PageBadge count={score.pageCount} />
          {score.key ? (
            <span className="text-sm font-semibold text-ink-700 dark:text-ink-200">{score.key}</span>
          ) : null}
          {score.tempo ? (
            <span className="text-sm font-semibold text-ink-700 dark:text-ink-200">
              {score.tempo}
            </span>
          ) : null}
          <span className="text-sm text-ink-600 dark:text-ink-300">{formatBytes(score.fileSize)}</span>
          {score.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-ink-400 px-2 text-sm font-medium text-ink-700 dark:border-ink-600 dark:text-ink-200"
            >
              {tag}
            </span>
          ))}
        </div>
      </div>

      <Button
        variant="primary"
        size="lg"
        onClick={() => {
          window.location.hash = href;
        }}
      >
        Play
      </Button>
      <ScoreMenu onEdit={onEdit} onDelete={onDelete} onAddToSetlist={onAddToSetlist} />
    </li>
  );
}
