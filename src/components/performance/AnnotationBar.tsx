import type { AnnotationTool } from '../../types';
import { Button, cx } from '../ui/controls';
import type { PenSettings } from './AnnotationLayer';

/**
 * Marking colours. Chosen to stay legible on white paper and to survive being
 * seen from a metre away under stage lighting — no pastels.
 */
export const PEN_COLOURS: Record<AnnotationTool, string[]> = {
  pen: ['#d32020', '#1668d8', '#12903f', '#111111'],
  highlighter: ['#ffe14d', '#7ef29a', '#79d0ff', '#ff9ad2'],
};

const PEN_WIDTHS: { label: string; width: number }[] = [
  { label: 'Fine', width: 0.0022 },
  { label: 'Medium', width: 0.004 },
  { label: 'Bold', width: 0.007 },
];

const HIGHLIGHTER_WIDTHS: { label: string; width: number }[] = [
  { label: 'Thin', width: 0.014 },
  { label: 'Wide', width: 0.026 },
];

export default function AnnotationBar({
  pen,
  onChange,
  onUndo,
  onClearPage,
  onDone,
  canUndo,
  pageLabel,
}: {
  pen: PenSettings;
  onChange: (next: PenSettings) => void;
  onUndo: () => void;
  onClearPage: () => void;
  onDone: () => void;
  canUndo: boolean;
  pageLabel: string;
}) {
  const colours = PEN_COLOURS[pen.tool];
  const widths = pen.tool === 'pen' ? PEN_WIDTHS : HIGHLIGHTER_WIDTHS;

  const selectTool = (tool: AnnotationTool) => {
    // Carry over a sensible colour and width for the new tool.
    onChange({
      tool,
      color: PEN_COLOURS[tool][0],
      width: tool === 'pen' ? PEN_WIDTHS[1].width : HIGHLIGHTER_WIDTHS[0].width,
    });
  };

  return (
    <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-3 border-t-2 border-ink-700 bg-ink-950/95 px-4 py-3 backdrop-blur-sm pad-safe-bottom">
      <div className="inline-flex rounded-xl border-2 border-ink-500 bg-ink-900 p-1">
        {(['pen', 'highlighter'] as AnnotationTool[]).map((tool) => (
          <button
            key={tool}
            type="button"
            aria-pressed={pen.tool === tool}
            onClick={() => selectTool(tool)}
            className={cx(
              'min-h-touch rounded-lg px-5 text-lg no-select transition-colors',
              pen.tool === tool
                ? 'bg-moss-500 font-semibold text-white'
                : 'font-medium text-ink-100 hover:bg-ink-700',
            )}
          >
            {tool === 'pen' ? 'Pen' : 'Highlighter'}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2" role="group" aria-label="Colour">
        {colours.map((colour) => (
          <button
            key={colour}
            type="button"
            aria-label={`Colour ${colour}`}
            aria-pressed={pen.color === colour}
            onClick={() => onChange({ ...pen, color: colour })}
            // The swatch sits on a white pad: it shows the colour as it will
            // look on the page, and stops near-black ink vanishing into the bar.
            className={cx(
              'h-touch w-touch rounded-full border-4 bg-white p-1.5 transition-transform',
              pen.color === colour
                ? 'scale-110 border-moss-400'
                : 'border-ink-600 hover:border-ink-400',
            )}
          >
            <span
              className="block h-full w-full rounded-full"
              style={{ backgroundColor: colour }}
            />
          </button>
        ))}
      </div>

      <div className="inline-flex rounded-xl border-2 border-ink-500 bg-ink-900 p-1" role="group" aria-label="Width">
        {widths.map((option) => (
          <button
            key={option.label}
            type="button"
            aria-pressed={pen.width === option.width}
            onClick={() => onChange({ ...pen, width: option.width })}
            className={cx(
              'min-h-touch rounded-lg px-4 text-lg no-select transition-colors',
              pen.width === option.width
                ? 'bg-moss-500 font-semibold text-white'
                : 'font-medium text-ink-100 hover:bg-ink-700',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      <Button
        size="lg"
        onClick={onUndo}
        disabled={!canUndo}
        className="!border-ink-500 !bg-ink-800 !text-white"
      >
        Undo
      </Button>
      <Button
        size="lg"
        variant="danger"
        onClick={onClearPage}
        disabled={!canUndo}
        title={`Clear all markings on ${pageLabel}`}
      >
        Clear page
      </Button>
      <Button size="xl" variant="primary" className="px-8" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}
