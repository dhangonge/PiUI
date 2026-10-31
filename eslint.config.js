// 共享 ESLint 基线：Node 侧包（protocol / pi-worker / server）。
// packages/app 有自己的配置（React 相关规则），见 packages/app/eslint.config.js。
//
// 用法（仓库根）：npm run lint

import js from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig } from 'eslint/config'

export default defineConfig([
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'packages/app/**', 'packages/app/src-tauri/**'],
  },
  {
    files: ['packages/{protocol,pi-worker,server}/src/**/*.ts', 'scripts/**/*.mjs'],
    extends: [js.configs.recommended, tseslint.configs.recommended, eslintConfigPrettier],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'prefer-const': 'warn',
    },
  },
])
