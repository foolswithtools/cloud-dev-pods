# Changelog

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
