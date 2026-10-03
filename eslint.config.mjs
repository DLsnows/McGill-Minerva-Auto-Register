import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      'coverage/**',
      // Playwright browser builds (`npm run e2e:install`) and run output. Without these,
      // `eslint .` walks the downloaded Chromium bundles and reports their own helper
      // scripts as project lint errors.
      '**/.pw-browsers/**',
      '**/.ms-playwright/**',
      '**/e2e/artifacts/**',
      '**/lighthouse-reports/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    // Node-side helper scripts (CI gates, e2e runner + fake backend, Lighthouse audit).
    // Without this block they match no `files` pattern that declares globals, so every
    // `console` / `process` / `URL` reference is reported as `no-undef`.
    files: ['scripts/**/*.{js,mjs,cjs,ts}', 'e2e/**/*.{js,mjs,cjs,ts}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  prettier,
);
