# VS Code for uddns

Open this repository as a folder, or add it as a folder in a multi-root workspace.
Install the recommendations from the Extensions view. Use **Tasks: Run Task** for
the commands below. Tasks run from this repository unless they state another directory.

Use the tool versions documented by the repository. Launch VS Code from the
prepared development shell, or reopen in the existing dev container when available.
Extension recommendations do not install command-line dependencies.

| Task | Command |
| --- | --- |
| build | `vp run build ` |
| verify | `vp run verify ` |
| check | `vp run check` |
| test | `vp run test` |
| typecheck | `vp run typecheck` |
| docs:check | `vp run docs:check` |
| Check diff whitespace | `git diff --check` |

Debug configurations are available in **Run and Debug**. Choose a test or help
configuration for development. The selected-file configurations run the selected
script, so select a test or an intended entry point.

The updater and MCP server configurations load your local `.env` and can contact
providers. Use the unit-test configuration for isolated debugging.
