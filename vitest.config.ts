import { defineConfig } from 'vitest/config';

// `npm run build` runs `tsc -b infra scripts`, which compiles every file in
// `infra/tsconfig.json`'s `include` (covers `test/**/*.ts`) into `infra/dist/`.
// Without explicit excludes, vitest then picks up the compiled `*.test.js`
// alongside the original `*.test.ts` and runs each suite twice — or fails
// outright when a compiled test references a relative path that no longer
// resolves from `dist/`. Restrict discovery to TypeScript sources and skip
// the build outputs that vitest's defaults don't always cover.
export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/cdk.out/**'],
  },
});
