import js from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores([
    'dist',
    'node_modules',
    'coverage',
    'public/material-icons',
    'src-tauri/target/**',
    // These are bundled extension examples, not app source. Some examples
    // intentionally use terminal control codes and CommonJS loading.
    'src-tauri/resources/examples/**',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
      eslintConfigPrettier,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
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
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/use-memo': 'warn',
      'react-refresh/only-export-components': 'warn',
    },
  },
  // 分层方向：features/chat 是渲染层（ChatArea/InputBox/Sidebar/PaneHeader/…），
  // features/pi-chat 是唯一挂载 Pi 会话的容器层（见 docs/app-architecture.md）。
  // 渲染层不得反向依赖容器层，否则两层会绕成环。
  {
    files: ['src/features/chat/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/features/pi-chat/**', '../pi-chat/*', '../../pi-chat/**'],
              message:
                'features/chat 是渲染层，不得依赖 features/pi-chat 容器；需要 Pi 数据请用 src/pi/** 的 store/hook。',
            },
          ],
        },
      ],
    },
  },
  // 容器只能由 App.tsx 挂载：App.tsx 负责 pane 布局、路由和跨 pane 协调。
  // 排除 features/chat（上一段单独给词）与容器自身：后定义的段会整个覆盖
  // 同名规则，不排除的话上一段的提示词就永远不会出现。
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/App.tsx', 'src/features/pi-chat/**', 'src/features/chat/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/features/pi-chat/**'],
              message: 'PiChatPane 只能由 App.tsx 挂载；其他位置请复用 App.tsx 传入的 props 或 src/pi/** 的 store。',
            },
          ],
        },
      ],
    },
  },
])
