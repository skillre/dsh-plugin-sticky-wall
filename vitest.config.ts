import { defineConfig } from 'vitest/config'

/**
 * Two environments in one suite: the Host halves run in Node, and the Client
 * component tests need a DOM. `environmentMatchGlobs` is deprecated, so the
 * per-file docblock (`// @vitest-environment jsdom`) selects the DOM files and
 * the project default stays Node.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    environment: 'node',
  },
})
