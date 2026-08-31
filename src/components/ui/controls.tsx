import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'md' | 'lg' | 'xl';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-moss-500 text-white hover:bg-moss-400 active:bg-moss-500 border-2 border-moss-500 font-semibold',
  secondary:
    'bg-white text-ink-900 border-2 border-ink-400 hover:border-ink-600 dark:bg-ink-800 dark:text-ink-100 dark:border-ink-600 dark:hover:border-ink-400 font-semibold',
  ghost:
    'bg-transparent text-ink-800 border-2 border-transparent hover:bg-ink-200 dark:text-ink-200 dark:hover:bg-ink-800 font-medium',
  danger:
    'bg-transparent text-red-700 border-2 border-red-600 hover:bg-red-600 hover:text-white dark:text-red-300 dark:border-red-400 dark:hover:bg-red-500 dark:hover:text-white font-semibold',
};

// Every size clears a 44px hit target; `xl` is for the performance view, where
// the user is reaching out mid-song.
const SIZES: Record<Size, string> = {
  md: 'min-h-[2.75rem] px-4 text-base gap-2',
  lg: 'min-h-[3.25rem] px-5 text-lg gap-2.5',
  xl: 'min-h-touch min-w-touch px-5 text-xl gap-3',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        'inline-flex items-center justify-center rounded-xl transition-colors',
        'disabled:opacity-40 disabled:cursor-not-allowed no-select',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    />
  );
});

export interface IconButtonProps extends ButtonProps {
  label: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, className, children, ...rest },
  ref,
) {
  return (
    <Button
      ref={ref}
      aria-label={label}
      title={label}
      className={cx('aspect-square !px-0', className)}
      {...rest}
    >
      {children}
    </Button>
  );
});

export const TextField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextField({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={cx('w-full min-h-[2.75rem] px-3 text-base', className)}
        {...rest}
      />
    );
  },
);

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-semibold uppercase tracking-wide text-ink-600 dark:text-ink-300">
        {label}
      </span>
      {hint ? <span className="block text-sm text-ink-600 dark:text-ink-300">{hint}</span> : null}
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'flex w-full items-center gap-4 rounded-xl border-2 p-4 text-left transition-colors no-select',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        checked
          ? 'border-moss-500 bg-moss-500/10'
          : 'border-ink-300 dark:border-ink-600 hover:border-ink-500 dark:hover:border-ink-400',
      )}
    >
      <span
        className={cx(
          'relative h-8 w-14 shrink-0 rounded-full border-2 transition-colors',
          checked ? 'bg-moss-500 border-moss-500' : 'bg-ink-300 border-ink-400 dark:bg-ink-700 dark:border-ink-600',
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-[1.6rem]' : 'translate-x-0.5',
          )}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-lg font-semibold">{label}</span>
        {description ? (
          <span className="block text-sm text-ink-600 dark:text-ink-300">{description}</span>
        ) : null}
      </span>
    </button>
  );
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
  ariaLabel,
  tone = 'default',
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (next: T) => void;
  size?: Size;
  ariaLabel: string;
  /**
   * 'onDark' is for the performance overlay, where the control sits above a
   * white score page. It paints an opaque background so inactive labels keep
   * their contrast whatever is underneath.
   */
  tone?: 'default' | 'onDark';
}) {
  const onDark = tone === 'onDark';
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cx(
        'inline-flex rounded-xl border-2 p-1',
        onDark ? 'border-ink-500 bg-ink-900' : 'border-ink-400 dark:border-ink-600',
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            title={option.title ?? undefined}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cx(
              'inline-flex items-center justify-center rounded-lg transition-colors no-select',
              SIZES[size],
              active
                ? 'bg-moss-500 font-semibold text-white'
                : onDark
                  ? 'font-medium text-ink-100 hover:bg-ink-700'
                  : 'font-medium text-ink-800 hover:bg-ink-200 dark:text-ink-200 dark:hover:bg-ink-800',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Working"
      className={cx(
        'inline-block h-5 w-5 animate-spin rounded-full border-[3px] border-current border-r-transparent',
        className,
      )}
    />
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h2 className="text-2xl font-bold">{title}</h2>
      <p className="mt-2 text-lg text-ink-700 dark:text-ink-200">{body}</p>
      {action ? <div className="mt-6 flex justify-center">{action}</div> : null}
    </div>
  );
}
