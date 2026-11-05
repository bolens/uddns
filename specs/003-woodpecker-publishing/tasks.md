# Tasks and evidence

- [x] Inventory every tracked GitHub workflow/job and release helper from current canonical main.
- [x] Verify direct GitHub source authority and server-side secret broker contract with coordinator.
- [x] Execute pinned native toolchain verification (485 tests), config/site checks, 15 adapter tests and pinned fleet validators.
- [x] Build current-main Pages without credentials; validate accessibility/links and four sequential Chromium viewports locally.
- [x] Prove initial adoption checks on the native GitHub PR event.
      Exact baseline 710d14eedc640de23fd6ed3db0175776d795dbea passed all hosted checks
      and native repository 13, pipeline 5, including its non-shallow assertion. The functional
      retirement head still requires fresh native and hosted results.
- [x] Stage active publisher/Pages configuration with broker/flag enforcement and exact-source identity helpers.
- [x] Independently review candidate/JIT helpers; fix retry, subprocess redaction and token-lifetime findings.
- [x] Execute publication denial, lease caching/refresh and identity unit tests.
- [x] Independently review publication/trust boundary and denial cases.
      Final review resolved hosted-token Variables permissions, shared-IP REST quota,
      and built-in-token Pages trigger gaps. Mocked evidence covers 20 bridge,
      20 publication-policy and 6 exact-native-status tests.
- [x] Prove safe socket-free build and isolated runtime fixture transport.
      A no-push Kaniko build and both offline configuration fixtures passed with
      private Docker volume transport; the pinned Syft 1.56.0 scanner produced an
      SPDX-2.3 inventory with 263 packages without a socket or registry credentials.
      The diagnostic image used an abbreviated revision label, so these results prove
      compatibility only. Final full-SHA archive/registry identity and native event
      acceptance remain required and are not inferred from this diagnostic.
- [ ] Prove thin GitHub OIDC bridge and Pages branch publishing without creating a release tag.
- [x] Prove actual 3.20 parser/compiler event filters exclude publisher steps and credential consumption for PR/manual/cron/Gitea events.
      Actual v3.20.1 parser, metadata matcher and compiler passed 256 event/branch/forge
      cases across both repositories, including wrong forge URLs and owners. Synthetic
      sentinels are absent from excluded publishers; the image/event barrier rejects
      registry secrets in command or environment steps. Provider HTTP fetching occurs
      before filtering; signed broker SDK isolated empty-secret integration passed; live acceptance remains pending.
- [ ] Prove the native clone's full-history assertion before retiring historical checks.
      Every workflow pins the already-installed clone plugin 2.11.0 with depth zero
      and partial false. The actual compiler preserves both settings and trusted
      clone authentication; the core job asserts the checkout is not shallow.
- [x] Prepare reviewed two-flag Linux retirement guards without changing retained exceptions.
      Actionlint and 396 combined flag/original-condition cases passed across both
      repositories. Broker isolated provider integration passed in the host coordinator's
      actual SDK3.18/3.20 runtime proof; live provider acceptance remains pending.
- [ ] Obtain final retirement-head PR and merged-main native acceptance before flags.
- [ ] Obtain native exact-head acceptance, then migrate required checks and remove duplicate triggers.

- [x] Prove actual v3.20 discovery and empty-secret compilation of the six/one validation workflows, unchanged contexts, drift/symlink/extra/reference denials and cached restart behavior.
- [ ] Independently review and deliver the validation-profile source, then verify live ordered profile/flag/cancellation readbacks and genuine main-push acceptance.

Unchecked items are required remaining work; no unexecuted path counts as a pass.

## Linux development-environment parity follow-up

- [x] Add the owning pinned native Linux test step and regenerate the validation profile.
- [x] Add the default-off hosted Linux test guard, preserving Docker/macOS/OIDC checks.
- [ ] Verify normal hooks, workflow lint and actual SDK event/profile/flag fixtures.
- [ ] Complete independent review and exact-head native PR acceptance.
- [ ] Verify genuine merged-main native parity before root enables `WOODPECKER_NIX_CI`.
- [ ] Reconcile the accepted source to Gitea without changing its governance overlays.

Cold Nix storage, runner timeout and actual test execution remain acceptance
requirements. No source, compiler or mocked check counts as runtime parity.

### Direct Nix CI managed-runtime correction

- [x] Diagnose the actual step545 failure and the managed Node ELF interpreter dependency.
- [x] Add an explicit disposable-CI wrapper sharing the existing Nix-derived loader/library closure.
- [x] Verify eight focused guard/idempotence/conflict/exec fixtures in temporary filesystems.
- [ ] Independently review the wrapper and prove managed Node in the exact Nix image.
- [ ] Pass normal hooks and the complete exact-head native development gate.
- [ ] Verify genuine merged-main parity before the operator enables the Nix cutover flag.
