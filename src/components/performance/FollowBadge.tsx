import type { Ensemble } from '../../types';
import type { FollowController } from '../../sync/usePageFollow';
import { Button, cx } from '../ui/controls';

/**
 * The follow-mode indicator.
 *
 * This is the one deliberate exception to "nothing but the score while
 * playing": it does not auto-hide. Whether your page turns are coming from
 * someone else is not a detail you should have to go looking for — a musician
 * who has silently dropped out of following, or who does not realise they are
 * following, is in a worse position than one looking at a small badge. It is
 * kept to a single line in a corner, and disappears entirely when no session is
 * running.
 */
export default function FollowBadge({
  follow,
  ensembles,
  missingTitle,
}: {
  follow: FollowController;
  ensembles: Ensemble[];
  /** Set when the director is on a score this device has no file for. */
  missingTitle: string | null;
}) {
  if (follow.state === 'off') return null;

  const group = ensembles.find((e) => e.id === follow.ensembleId);
  const name = group?.name ?? 'Ensemble';

  const tone =
    follow.state === 'following' || follow.state === 'leading'
      ? 'border-moss-400 bg-moss-500/95 text-white'
      : follow.state === 'released'
        ? 'border-ink-500 bg-ink-900/95 text-ink-100'
        : 'border-amber-400 bg-amber-400/95 text-ink-950';

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-40 flex justify-center pad-safe-top">
      <div
        role="status"
        className={cx(
          'pointer-events-auto m-2 flex max-w-[95vw] items-center gap-3 rounded-xl border-2 px-4 py-2 shadow-lg backdrop-blur-sm',
          tone,
        )}
      >
        <span className="text-base font-bold">
          {follow.state === 'leading' ? (
            <>
              Leading {name} · {follow.listeners}{' '}
              {follow.listeners === 1 ? 'follower' : 'followers'}
            </>
          ) : follow.state === 'following' ? (
            missingTitle ? (
              <>Director is on “{missingTitle}” — not on this device</>
            ) : (
              <>Following {name}</>
            )
          ) : follow.state === 'released' ? (
            <>Following stopped</>
          ) : (
            <>Not following — connection lost</>
          )}
        </span>

        {follow.state === 'released' ? (
          <Button
            onClick={follow.resume}
            className="!border-moss-400 !bg-moss-500 !text-white"
          >
            Resume
          </Button>
        ) : null}

        <Button
          onClick={follow.stop}
          aria-label="Leave the follow session"
          className="!border-current !bg-transparent !text-current"
        >
          {follow.state === 'leading' ? 'Stop' : 'Leave'}
        </Button>
      </div>
    </div>
  );
}
