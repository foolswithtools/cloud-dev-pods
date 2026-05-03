# config/

Configuration for the CDK app and runtime workflows.

- `config.example.yaml` — committed template. Copy to `config.yaml` and customize.
- `config.yaml` — gitignored. Loaded at synth time by `infra/lib/config/config.ts`.

The schema is enforced by `infra/lib/config/schema.ts` (Zod). Validate with:

```bash
npx tsx scripts/render-config.ts
```
