import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      'server-only': path.resolve(__dirname, 'tests/stubs/server-only.ts'),
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
