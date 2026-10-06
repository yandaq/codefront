/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: { fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui'], mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'] }, colors: { void: '#0a0e17' } } },
};
