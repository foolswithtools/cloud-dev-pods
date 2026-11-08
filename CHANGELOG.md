# Changelog

## [0.4.9](https://github.com/foolswithtools/cloud-dev-pods/compare/v0.4.8...v0.4.9) (2026-11-08)


### Bug Fixes

* **smoke-test:** cleanup skips cdk destroy when cluster-up fails before PodManager exists ([#246](https://github.com/foolswithtools/cloud-dev-pods/issues/246)) ([549d2aa](https://github.com/foolswithtools/cloud-dev-pods/commit/549d2aa1a1281f49b4e1e6767dcf24cc38279cd5))

## [0.4.8](https://github.com/foolswithtools/cloud-dev-pods/compare/v0.4.7...v0.4.8) (2026-11-04)


### Features

* **cluster-down:** guard EFS workspaces and ask about retention in init ([#243](https://github.com/foolswithtools/cloud-dev-pods/issues/243)) ([26da28b](https://github.com/foolswithtools/cloud-dev-pods/commit/26da28b3b8099d0026bc861148d1b6bdea67e55a))
* **init:** add --post-bootstrap to set role ARNs and delete bootstrap credentials ([#242](https://github.com/foolswithtools/cloud-dev-pods/issues/242)) ([ad5075d](https://github.com/foolswithtools/cloud-dev-pods/commit/ad5075dc07ced97832760a31d50216c67eb6f572)), closes [#226](https://github.com/foolswithtools/cloud-dev-pods/issues/226)


### Bug Fixes

* **infra:** load infra/extensions.local.ts hooks and let forks commit the file ([#240](https://github.com/foolswithtools/cloud-dev-pods/issues/240)) ([23ef35b](https://github.com/foolswithtools/cloud-dev-pods/commit/23ef35bdd23e2640a49475464a8d416cd3b83c12)), closes [#239](https://github.com/foolswithtools/cloud-dev-pods/issues/239)

## [0.4.7](https://github.com/foolswithtools/cloud-dev-pods/compare/v0.4.6...v0.4.7) (2026-11-03)


### Bug Fixes

* **pod-manager:** drop Route 53 grants and scope EFS/ECS permissions ([#235](https://github.com/foolswithtools/cloud-dev-pods/issues/235)) ([880e7a7](https://github.com/foolswithtools/cloud-dev-pods/commit/880e7a76d9cf645aadaf075f166e353ccea5da67)), closes [#224](https://github.com/foolswithtools/cloud-dev-pods/issues/224)
* **pod-up:** hide mode ssh until a remote-access backend ships ([#234](https://github.com/foolswithtools/cloud-dev-pods/issues/234)) ([012c596](https://github.com/foolswithtools/cloud-dev-pods/commit/012c59608bab2743defcce0823b72622cf3d080d)), closes [#228](https://github.com/foolswithtools/cloud-dev-pods/issues/228)
* **workflows:** keep pod runs out of the cluster concurrency group ([#238](https://github.com/foolswithtools/cloud-dev-pods/issues/238)) ([d11be04](https://github.com/foolswithtools/cloud-dev-pods/commit/d11be04895346c8e59a801745f453e035b524310))
* **workflows:** teardown concurrency and prefix-derived stack names ([#236](https://github.com/foolswithtools/cloud-dev-pods/issues/236)) ([0d66eca](https://github.com/foolswithtools/cloud-dev-pods/commit/0d66eca8cfee86e7571c6679aef97a7723b52698)), closes [#225](https://github.com/foolswithtools/cloud-dev-pods/issues/225)

## [0.4.6](https://github.com/foolswithtools/cloud-dev-pods/compare/v0.4.5...v0.4.6) (2026-11-03)


### Bug Fixes

* **idle-reaper:** skip browser pods younger than their idle window ([#231](https://github.com/foolswithtools/cloud-dev-pods/issues/231)) ([caa354d](https://github.com/foolswithtools/cloud-dev-pods/commit/caa354da5a5178119eef63ef50b95377c38b1724)), closes [#229](https://github.com/foolswithtools/cloud-dev-pods/issues/229)
* **pod-task-family:** drop task-role log-stream grants and read the tunnel device code from the task's own stream ([#233](https://github.com/foolswithtools/cloud-dev-pods/issues/233)) ([d0d5e28](https://github.com/foolswithtools/cloud-dev-pods/commit/d0d5e2805a8875d4ac5afa0c6577e6c8bc918d20))

## [0.4.5](https://github.com/foolswithtools/cloud-dev-pods/compare/v0.4.4...v0.4.5) (2026-11-03)


### Features

* **cluster:** enforce TLS and access-point-only EFS access with a file-system policy ([#218](https://github.com/foolswithtools/cloud-dev-pods/issues/218)) ([ecc4a7e](https://github.com/foolswithtools/cloud-dev-pods/commit/ecc4a7e2b29547bb21a8c798e481bf6bd4e455d3)), closes [#217](https://github.com/foolswithtools/cloud-dev-pods/issues/217)

## [0.4.4](https://github.com/foolswithtools/cloud-dev-pods/compare/v0.4.3...v0.4.4) (2026-11-02)


### Bug Fixes

* **cluster-down:** fail closed when the pod pre-flight list fails or a forced drain leaves pods ([#210](https://github.com/foolswithtools/cloud-dev-pods/issues/210)) ([716dfbf](https://github.com/foolswithtools/cloud-dev-pods/commit/716dfbf4b7534d6b6eefdd72521509e312f60882)), closes [#209](https://github.com/foolswithtools/cloud-dev-pods/issues/209)
* **cluster-down:** require positive proof from cluster-drain before cdk destroy ([#213](https://github.com/foolswithtools/cloud-dev-pods/issues/213)) ([8357466](https://github.com/foolswithtools/cloud-dev-pods/commit/83574663a7d7fbaa0eae7a5ccd9c507419a7be8f)), closes [#211](https://github.com/foolswithtools/cloud-dev-pods/issues/211)
* **scripts:** resolve symlinks in the isInvokedAsCli guard so main() runs from a symlinked path ([#207](https://github.com/foolswithtools/cloud-dev-pods/issues/207)) ([424f3a6](https://github.com/foolswithtools/cloud-dev-pods/commit/424f3a690c23b77296a418968add1ac4a29d6890)), closes [#194](https://github.com/foolswithtools/cloud-dev-pods/issues/194)
* **smoke-test:** drain pods via cluster-drain.ts before cdk destroy ([#214](https://github.com/foolswithtools/cloud-dev-pods/issues/214)) ([04bb260](https://github.com/foolswithtools/cloud-dev-pods/commit/04bb260484a9fb4a6796d9325000437faaf69fb0)), closes [#212](https://github.com/foolswithtools/cloud-dev-pods/issues/212)

## [0.4.3](https://github.com/foolswithtools/cloud-dev-pods/compare/v0.4.2...v0.4.3) (2026-11-02)


### Features

* **auth:** generic OIDC browser provider (provider: oidc) ([#199](https://github.com/foolswithtools/cloud-dev-pods/issues/199)) ([cd7560d](https://github.com/foolswithtools/cloud-dev-pods/commit/cd7560da6d023bd85c3ab54d71a9705a27e9eb49))
* **init:** GitHub/Entra provider, ownerOnly and tunnel-provider prompts with non-interactive mode ([#204](https://github.com/foolswithtools/cloud-dev-pods/issues/204)) ([95c9e4a](https://github.com/foolswithtools/cloud-dev-pods/commit/95c9e4aed1c1bbd296e375f2f0cb47e22cc577b9))
* **remote-access:** ssh pod mode, remote.backend config and ssh IAM roles ([#184](https://github.com/foolswithtools/cloud-dev-pods/issues/184)) ([27b3e9b](https://github.com/foolswithtools/cloud-dev-pods/commit/27b3e9ba388b83acc6fa2d20084943cc30c06639)), closes [#145](https://github.com/foolswithtools/cloud-dev-pods/issues/145)
* **remote-access:** sshd and POD_MODE dispatch in the tunnel runtime image ([#190](https://github.com/foolswithtools/cloud-dev-pods/issues/190)) ([3830fab](https://github.com/foolswithtools/cloud-dev-pods/commit/3830fabb4a6470e125163c5118cf5a34e08da27c)), closes [#181](https://github.com/foolswithtools/cloud-dev-pods/issues/181)


### Bug Fixes

* **config:** make config.smoke.example.yaml pass the schema and test every example config ([#200](https://github.com/foolswithtools/cloud-dev-pods/issues/200)) ([d183dc2](https://github.com/foolswithtools/cloud-dev-pods/commit/d183dc2f1aeb925ccf8271ed9413cecbb43f2e4a)), closes [#195](https://github.com/foolswithtools/cloud-dev-pods/issues/195)
* **init:** write auth.browser.* instead of deprecated github.oauthAllowed* keys ([#189](https://github.com/foolswithtools/cloud-dev-pods/issues/189)) ([b3294ec](https://github.com/foolswithtools/cloud-dev-pods/commit/b3294ece72def8a55ea397ef884015f2c86de0a2)), closes [#170](https://github.com/foolswithtools/cloud-dev-pods/issues/170)
* **pod-manager:** bind retained workspaces to their owner and give released workspaces a fresh path ([#203](https://github.com/foolswithtools/cloud-dev-pods/issues/203)) ([1d6d6bb](https://github.com/foolswithtools/cloud-dev-pods/commit/1d6d6bb60d4430074afc090df0cb34ed6dbb5e27)), closes [#191](https://github.com/foolswithtools/cloud-dev-pods/issues/191)
* **tunnel:** log code tunnel unregister on SIGTERM ([#201](https://github.com/foolswithtools/cloud-dev-pods/issues/201)) ([43968d4](https://github.com/foolswithtools/cloud-dev-pods/commit/43968d44ded7533a7b73e93bebcf9cbf21823444)), closes [#192](https://github.com/foolswithtools/cloud-dev-pods/issues/192)

## [0.4.2](https://github.com/foolswithtools/cloud-dev-pods/compare/v0.4.1...v0.4.2) (2026-10-23)


### Features

* **auth:** Microsoft Entra ID provider for browser pods ([#160](https://github.com/foolswithtools/cloud-dev-pods/issues/160)) ([03ec2fa](https://github.com/foolswithtools/cloud-dev-pods/commit/03ec2fa7ef12cec7630d44e38f161062730db376))
* **auth:** per-pod cookie secret for owner-only browser pods ([#164](https://github.com/foolswithtools/cloud-dev-pods/issues/164)) ([b523662](https://github.com/foolswithtools/cloud-dev-pods/commit/b523662006326a9f0ae6d6130502e5c887361230))
* **tunnel:** unregister tunnels on pod-down and warn near the 10-tunnel cap ([#163](https://github.com/foolswithtools/cloud-dev-pods/issues/163)) ([120ea67](https://github.com/foolswithtools/cloud-dev-pods/commit/120ea6754a4bcdb8ec3e8da3f9bfc786db21ed4f))

## [0.4.1](https://github.com/foolswithtools/cloud-dev-pods/compare/v0.4.0...v0.4.1) (2026-10-22)


### Features

* **auth:** opt-in per-pod owner authorization for browser pods ([#157](https://github.com/foolswithtools/cloud-dev-pods/issues/157)) ([b41817b](https://github.com/foolswithtools/cloud-dev-pods/commit/b41817b6616b0aa39f8f2d88298f48de7b70776c))
* **auth:** provider-neutral auth config block and ADR 0008 ([#152](https://github.com/foolswithtools/cloud-dev-pods/issues/152)) ([52a8819](https://github.com/foolswithtools/cloud-dev-pods/commit/52a88190e273d5aae27c869dd43f8dffd3c6c8a4))
* **auth:** provider-neutral guard against unrestricted browser pods ([#155](https://github.com/foolswithtools/cloud-dev-pods/issues/155)) ([371b59d](https://github.com/foolswithtools/cloud-dev-pods/commit/371b59d1791c466ac52e778425abc2448d3a1785))
* **auth:** single oauth2-proxy sidecar builder and upgrade to v7.8 or later ([#154](https://github.com/foolswithtools/cloud-dev-pods/issues/154)) ([ab1c232](https://github.com/foolswithtools/cloud-dev-pods/commit/ab1c2325c63850dd16748abdeb5412db53693a41))
* **tunnel:** choose GitHub or Microsoft (Entra) account for tunnel login ([#159](https://github.com/foolswithtools/cloud-dev-pods/issues/159)) ([5e6e794](https://github.com/foolswithtools/cloud-dev-pods/commit/5e6e79440f33ab7c413d13ae6a1877ca522257af))

## [0.4.0](https://github.com/foolswithtools/cloud-dev-pods/compare/v0.3.1...v0.4.0) (2026-10-18)


### ⚠ BREAKING CHANGES

* **runtime:** tunnel pods now ship Node 22 (was 18), Python 3.14 (was 3.12) and git 2.53 (was 2.43) from the Ubuntu 26.04 archive. npm stays 9.2.0. Workspace code pinned to the old interpreters may need updating. Run build-runtime after syncing to pick up the image.

### Features

* **runtime:** move tunnel image to Ubuntu 26.04 LTS ([#126](https://github.com/foolswithtools/cloud-dev-pods/issues/126)) ([b766d68](https://github.com/foolswithtools/cloud-dev-pods/commit/b766d682a40b67ba6c413149c398987a0d606dbc))

## [0.3.1](https://github.com/foolswithtools/cloud-dev-pods/compare/v0.3.0...v0.3.1) (2026-10-18)


### Bug Fixes

* **deps:** ignore interim Ubuntu tags by exact version ([#121](https://github.com/foolswithtools/cloud-dev-pods/issues/121)) ([1a40c2b](https://github.com/foolswithtools/cloud-dev-pods/commit/1a40c2ba318c6f610dacb5d5989e4a4f916c0f45))

## [0.3.0](https://github.com/foolswithtools/cloud-dev-pods/compare/v0.2.3...v0.3.0) (2026-10-18)


### ⚠ BREAKING CHANGES

* **deps:** forks that call NagSuppressions in infra/extensions.local.ts must switch to acknowledgeNag() from infra/lib/util/nag.ts (or Validations.of(x).acknowledge) and list granular findings in appliesTo.

### Bug Fixes

* **runtime:** pin tunnel image back to Ubuntu 24.04 LTS ([#112](https://github.com/foolswithtools/cloud-dev-pods/issues/112)) ([0e49860](https://github.com/foolswithtools/cloud-dev-pods/commit/0e498602d41fd8a712c1599c0a01cf79b16c4081))


### Miscellaneous Chores

* **deps:** migrate to cdk-nag v3 ([#113](https://github.com/foolswithtools/cloud-dev-pods/issues/113)) ([88b15a1](https://github.com/foolswithtools/cloud-dev-pods/commit/88b15a1da7d5bdf9dc8f6d97026f2e400abec7e1))

## [0.2.3](https://github.com/foolswithtools/cloud-dev-pods/compare/v0.2.2...v0.2.3) (2026-10-18)


### Bug Fixes

* **deps:** clear osv-scanner backlog and drop expired suppressions ([#97](https://github.com/foolswithtools/cloud-dev-pods/issues/97)) ([b15ef56](https://github.com/foolswithtools/cloud-dev-pods/commit/b15ef567aa7f5f39e570d5c9d7cc836fff7acd77)), closes [#45](https://github.com/foolswithtools/cloud-dev-pods/issues/45)
* **runtime:** move tunnel image to Ubuntu 24.04 LTS ([#100](https://github.com/foolswithtools/cloud-dev-pods/issues/100)) ([c8211d9](https://github.com/foolswithtools/cloud-dev-pods/commit/c8211d907cc210281f44842e329f60cc67bb96ad))

## [0.2.2](https://github.com/foolswithtools/cloud-dev-pods/compare/v0.2.1...v0.2.2) (2026-05-10)


### Bug Fixes

* **runtime:** grant tunnel vscode user passwordless sudo ([#48](https://github.com/foolswithtools/cloud-dev-pods/issues/48)) ([2795982](https://github.com/foolswithtools/cloud-dev-pods/commit/27959827c87da7dde02cd999cb44c18d5e047f34)), closes [#47](https://github.com/foolswithtools/cloud-dev-pods/issues/47)

## [0.2.1](https://github.com/foolswithtools/cloud-dev-pods/compare/v0.2.0...v0.2.1) (2026-05-10)


### Bug Fixes

* **eslint:** add flat config so npm run lint works ([#42](https://github.com/foolswithtools/cloud-dev-pods/issues/42)) ([6af0864](https://github.com/foolswithtools/cloud-dev-pods/commit/6af08646f414b65d83a26325d5cbb22ab58df04e))
* **test:** explicit vitest config to skip compiled output ([#44](https://github.com/foolswithtools/cloud-dev-pods/issues/44)) ([5397cde](https://github.com/foolswithtools/cloud-dev-pods/commit/5397cde89823d7ee178a5905b258f0304976d740))

## [0.2.0](https://github.com/foolswithtools/cloud-dev-pods/compare/v0.1.1...v0.2.0) (2026-05-10)


### ⚠ BREAKING CHANGES

* ClusterStack EFS now defaults to RemovalPolicy.DESTROY. Set `efs.retainOnClusterDown: true` in config to preserve prior behavior. Pod-manager Lambda now reuses the existing per-pod EFS access point on repeat pod-up, restoring workspace persistence across down/up cycles.

### Features

* efs RemovalPolicy DESTROY default and per-pod AP reuse ([#39](https://github.com/foolswithtools/cloud-dev-pods/issues/39)) ([9ce5370](https://github.com/foolswithtools/cloud-dev-pods/commit/9ce53705be881b2992b634a881979f71b90278cc))

## [0.1.1](https://github.com/foolswithtools/cloud-dev-pods/compare/v0.1.0...v0.1.1) (2026-05-10)


### Features

* **governance:** Phase 14 — apply-repo-settings + CODEOWNERS structure ([#25](https://github.com/foolswithtools/cloud-dev-pods/issues/25)) ([b7a6305](https://github.com/foolswithtools/cloud-dev-pods/commit/b7a6305abf9ab4c8f34544f5cd43fb06cf665154))
* **infra:** implement BootstrapStack + NetworkStack; wire cdk-synth into CI ([#9](https://github.com/foolswithtools/cloud-dev-pods/issues/9)) ([eefb1e2](https://github.com/foolswithtools/cloud-dev-pods/commit/eefb1e2770a8a5e411cfcd821e84f7a87009f363))
* **infra:** implement ClusterStack — ECS, EFS, ALB, listener, log groups ([#12](https://github.com/foolswithtools/cloud-dev-pods/issues/12)) ([9abfb14](https://github.com/foolswithtools/cloud-dev-pods/commit/9abfb145135ad16929be149ef9d4aa6e30abe711))
* **infra:** Phase 7a — pod IaC scaffolding (PodTaskFamily + PodManager) ([#13](https://github.com/foolswithtools/cloud-dev-pods/issues/13)) ([b0e60b1](https://github.com/foolswithtools/cloud-dev-pods/commit/b0e60b1a79862bdc82e3dc54d05037712c9be9d5))
* **infra:** Phase 7b — pod-manager Lambda business logic ([#14](https://github.com/foolswithtools/cloud-dev-pods/issues/14)) ([cbd2ff7](https://github.com/foolswithtools/cloud-dev-pods/commit/cbd2ff730cc8ae7f4ef4f2bf8a9b1d8a52f1fabc))
* **infra:** Phase 8 — IdleReaperStack with two-phase shutdown + cleanup-on-stop ([#15](https://github.com/foolswithtools/cloud-dev-pods/issues/15)) ([0a157e6](https://github.com/foolswithtools/cloud-dev-pods/commit/0a157e6ffbdf4e2862bc55922943ebde8abb7ba7))
* **infra:** Phase 9.5 — IaC-manage oauth Secrets Manager secrets ([#17](https://github.com/foolswithtools/cloud-dev-pods/issues/17)) ([7c9f0b3](https://github.com/foolswithtools/cloud-dev-pods/commit/7c9f0b340b8bcb941fd59881edc7ca6f6cefcb60))
* Phase 15 — smoke-test workflow + status update ([#26](https://github.com/foolswithtools/cloud-dev-pods/issues/26)) ([7b0f81b](https://github.com/foolswithtools/cloud-dev-pods/commit/7b0f81b1b6f779955a2f613e7f5abe526de0c7a9))
* **release:** Phase 13 — wire release-please in manifest mode ([#24](https://github.com/foolswithtools/cloud-dev-pods/issues/24)) ([dc5658b](https://github.com/foolswithtools/cloud-dev-pods/commit/dc5658b021c4f36b8e93b501f702447bba2fe1a0))
* **runtime:** Phase 5 — runtime image build + scan ([#11](https://github.com/foolswithtools/cloud-dev-pods/issues/11)) ([aa2f388](https://github.com/foolswithtools/cloud-dev-pods/commit/aa2f388942e25923cb8caf60939dc789d786902b))
* **scripts:** Phase 10 — implement upstream-sync workflow ([#21](https://github.com/foolswithtools/cloud-dev-pods/issues/21)) ([5986e73](https://github.com/foolswithtools/cloud-dev-pods/commit/5986e73eb898b4a8c261ce3e840d5a7b701af162))
* **scripts:** Phase 12 — implement init-clone interactive setup ([#23](https://github.com/foolswithtools/cloud-dev-pods/issues/23)) ([9fec93f](https://github.com/foolswithtools/cloud-dev-pods/commit/9fec93fc50fddfb1e6b0a673bfbaa22f6a439729))
* **workflows:** Phase 9 — wire user-facing provisioning workflows ([#16](https://github.com/foolswithtools/cloud-dev-pods/issues/16)) ([3ca3030](https://github.com/foolswithtools/cloud-dev-pods/commit/3ca303013e60435b1b9c3d6371a8b82142166124))


### Bug Fixes

* **infra:** Phase 9.8 — reaper CW dimension + cookie-secret length ([#20](https://github.com/foolswithtools/cloud-dev-pods/issues/20)) ([e0bad73](https://github.com/foolswithtools/cloud-dev-pods/commit/e0bad7390e07f97baa216e791b5811c3840a7add))
* **infra:** resolve full Secrets Manager ARNs at runtime in task defs ([#19](https://github.com/foolswithtools/cloud-dev-pods/issues/19)) ([752bed7](https://github.com/foolswithtools/cloud-dev-pods/commit/752bed751c29e1d39b830b35dc58f88b66cc5c7e))
* **infra:** set DESTROY removalPolicy on flow-logs LG and registry table ([#27](https://github.com/foolswithtools/cloud-dev-pods/issues/27)) ([3461890](https://github.com/foolswithtools/cloud-dev-pods/commit/3461890ae3077b68844e39ffe2abc0b6eb12cb23))
* **infra:** thread oauth2-proxy auth allowlists end-to-end ([#18](https://github.com/foolswithtools/cloud-dev-pods/issues/18)) ([376c242](https://github.com/foolswithtools/cloud-dev-pods/commit/376c24276a2206b9f51dcaaae752bb80a254a817))
