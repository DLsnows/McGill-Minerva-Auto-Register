import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['packages/{shared,server}/src/**/*.{test,spec}.ts'],
          environment: 'node',
        },
      },
      './packages/web/vitest.config.ts',
    ],
  },
});
