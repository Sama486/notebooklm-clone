import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Nur die reine Logik wird hier geprüft - Bauteile werden im Browser
    // getestet, nicht nachgebaut.
    include: ['src/**/*.test.ts'],
  },
});
