import { defineConfig } from 'vite-plus';

export default defineConfig({
  lint: {
    ignorePatterns: ['dist/**', 'coverage/**', '.pnpm-store/**'],
    options: { typeAware: true, typeCheck: true },
    env: { node: true },
  },
  fmt: {
    ignorePatterns: ['dist/**', 'coverage/**', 'pnpm-lock.yaml'],
    singleQuote: true,
    semi: true,
    sortPackageJson: true,
  },
  staged: {
    '*.{ts,js,mjs,cjs,json,md,yml,yaml}': 'vp check --fix',
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      ...(process.env['RUN_LIVE_TESTS'] === '1' ? [] : ['tests/live/**']),
    ],
    fileParallelism: true,
    coverage: {
      provider: 'v8',
      include: ['app.ts', 'lib/**/*.ts'],
      exclude: ['**/*.test.ts', 'tests/**'],
      reporter: ['text', 'html', 'clover', 'json'],
      reportsDirectory: './coverage',
      ...(process.env['VITEST_PARTIAL_COVERAGE'] === '1'
        ? {}
        : {
            thresholds: {
              statements: 95,
              branches: 90,
              functions: 95,
              lines: 95,
            },
          }),
    },
  },
});
