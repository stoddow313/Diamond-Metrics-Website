import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores([
    'dist',
    // Sidelined pre-backend demo app (routes commented out in App.jsx).
    // Un-ignore these if/when the old coach dashboard is restored.
    'src/components/app/**',
    'src/pages/DashboardPage.jsx',
    'src/pages/RosterPage.jsx',
    'src/pages/FilmRoomPage.jsx',
    'src/pages/GameDetailPage.jsx',
    'src/pages/PlayerDetailPage.jsx',
    'src/pages/SignupPage.jsx',
    'src/pages/admin/AdminReviewPage.jsx',
    'src/pages/admin/AdminFilmQueuePage.jsx',
    'src/data/adminData.js',
    'src/data/dummyData.js',
  ]),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
  {
    files: ['server/**/*.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
])
