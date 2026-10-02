import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypeScript from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      'react-hooks/immutability': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/static-components': 'off'
    }
  },
  {
    files: ['scripts/**/*.{js,cjs,mjs}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  globalIgnores([
    '.next/**',
    'dist/**',
    'coverage/**',
    'node_modules/**',
    'outputs/**',
    'storage/**',
    'next-env.d.ts'
  ])
]);
