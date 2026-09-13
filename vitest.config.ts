import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/**/*.test.ts', 'gecko/lib/**/*.test.ts'],
    environment: 'node'
  }
});
