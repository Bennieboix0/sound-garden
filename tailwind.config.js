/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Deliberately high-contrast. Nothing in this palette relies on thin
        // light-grey text, which is unreadable on a dim stage.
        ink: {
          950: '#08090a',
          900: '#0b0d0c',
          850: '#121514',
          800: '#181c1a',
          700: '#232826',
          600: '#333a37',
          500: '#4c5652',
          400: '#77837e',
          300: '#a7b2ad',
          200: '#d2d8d5',
          100: '#eef1ef',
        },
        moss: {
          // Primary accent. Chosen to clear 4.5:1 on ink-900 and on white.
          500: '#3fa34d',
          400: '#4fbf5f',
          300: '#6bd97a',
          200: '#9ceba6',
        },
        amber: {
          400: '#f2b134',
          300: '#f7c85c',
        },
      },
      fontFamily: {
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Inter',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
      },
      spacing: {
        // Minimum comfortable hit target for a shaky hand mid-song.
        touch: '3.5rem',
      },
      keyframes: {
        'page-in-next': {
          '0%': { opacity: '0.35', transform: 'translateX(2.5%)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'page-in-prev': {
          '0%': { opacity: '0.35', transform: 'translateX(-2.5%)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'toast-in': {
          '0%': { opacity: '0', transform: 'translateY(0.75rem)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        // Kept short: the page is already rendered, this is decoration only and
        // must never sit between the pedal press and the new page being visible.
        'page-in-next': 'page-in-next 130ms ease-out',
        'page-in-prev': 'page-in-prev 130ms ease-out',
        'toast-in': 'toast-in 140ms ease-out',
      },
    },
  },
  plugins: [],
};
