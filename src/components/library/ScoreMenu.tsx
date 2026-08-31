import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconButton, cx } from '../ui/controls';

interface Item {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

/** Matches the w-56 below; used to place the menu before it has been measured. */
const MENU_WIDTH = 224;
const ESTIMATED_HEIGHT = 148;
const EDGE_GAP = 8;

/**
 * Overflow menu for a score.
 *
 * Rendered into a portal with fixed positioning rather than absolutely inside
 * the card: the card clips its own overflow to round off the thumbnail, and the
 * trigger sits on its bottom edge, so an in-card menu is invisible. Flips above
 * the button when there is no room below.
 */
export default function ScoreMenu({
  onEdit,
  onDelete,
  onAddToSetlist,
}: {
  onEdit: () => void;
  onDelete: () => void;
  onAddToSetlist: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const height = menuRef.current?.offsetHeight || ESTIMATED_HEIGHT;

    const roomBelow = window.innerHeight - rect.bottom;
    const openUpwards = roomBelow < height + EDGE_GAP && rect.top > height + EDGE_GAP;

    // Right-align to the button, then keep the whole menu on screen.
    const left = Math.min(
      Math.max(EDGE_GAP, rect.right - MENU_WIDTH),
      window.innerWidth - MENU_WIDTH - EDGE_GAP,
    );
    const preferred = openUpwards ? rect.top - height - 4 : rect.bottom + 4;
    // Backstop: whatever the preferred side works out to, keep the menu on screen.
    const top = Math.min(
      Math.max(EDGE_GAP, preferred),
      Math.max(EDGE_GAP, window.innerHeight - height - EDGE_GAP),
    );
    setCoords({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    // Runs twice by design: once with the estimate, then again once the menu is
    // mounted and its real height is known.
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      // The menu lives in a portal, so it is not inside the trigger's wrapper —
      // both have to be checked or selecting an item would close the menu on
      // pointerdown and the click would never land.
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    // Scrolling closes the menu rather than repositioning it. Chasing the
    // trigger would drag the menu off screen once the card itself scrolls out
    // of view, and someone who scrolls has moved on from the menu anyway.
    const closeOnScroll = () => setOpen(false);

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', place);
    // Capture phase catches scrolling of any ancestor, not just the window.
    window.addEventListener('scroll', closeOnScroll, true);

    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', closeOnScroll, true);
    };
  }, [open, place]);

  const items: Item[] = [
    { label: 'Add to setlist…', onSelect: onAddToSetlist },
    { label: 'Edit details…', onSelect: onEdit },
    { label: 'Delete', onSelect: onDelete, danger: true },
  ];

  return (
    <>
      <IconButton
        ref={buttonRef}
        label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <span aria-hidden className="text-xl leading-none">
          ⋯
        </span>
      </IconButton>

      {open
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              style={{
                position: 'fixed',
                top: coords?.top ?? -9999,
                left: coords?.left ?? -9999,
                width: MENU_WIDTH,
              }}
              className="z-50 overflow-hidden rounded-xl border-2 border-ink-400 bg-white shadow-2xl dark:border-ink-600 dark:bg-ink-800"
            >
              {items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                  className={cx(
                    'block w-full px-4 py-3 text-left text-base font-semibold transition-colors',
                    item.danger
                      ? 'text-red-700 hover:bg-red-600 hover:text-white dark:text-red-300 dark:hover:bg-red-500 dark:hover:text-white'
                      : 'hover:bg-ink-200 dark:hover:bg-ink-700',
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
