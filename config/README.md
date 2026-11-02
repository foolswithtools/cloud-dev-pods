# config/

Configuration for the CDK app and runtime workflows.

- `config.example.yaml` — committed template. Copy to `config.yaml` and customize.
- `config.yaml` — gitignored. Loaded at synth time by `infra/lib/config/config.ts`.
- `config.smoke.example.yaml` — committed template for the smoke-test workflow. Copy to `config.smoke.yaml` and fill in the sandbox account id.

Both example files (every `config/*.example.yaml`) are schema-checked by `infra/test/example-configs.test.ts`, so an example that drifts from the schema fails `npm test`.

The schema is enforced by `infra/lib/config/schema.ts` (Zod). Validate with:

```bash
npx tsx scripts/render-config.ts
```
