import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['js/vendor/**', 'node_modules/**', 'server/data/**'] },
  js.configs.recommended,
  {
    files: ['js/**/*.js', 'sw.js', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, DOMPurify: 'readonly' },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-implicit-globals': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  { files: ['sw.js'], languageOptions: { sourceType: 'script', globals: { ...globals.serviceworker } } },
  {
    files: ['server/**/*.js', 'tools/**/*.mjs', 'tests/**/*.mjs', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
  },
];
