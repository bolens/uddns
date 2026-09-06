# Implementation plan

Own devenv inputs/module/lock, the development wrapper and container adapter,
adapter tests, environment documentation, ignore rules, and the environment CI.
Preserve application code, provider security, runtime data, release versions,
and upstream-managed Spec Kit files. Use the repository package scripts and
existing test sharding rather than introducing a second JavaScript test runner.

Verify the pinned Node package and native dependency requirements before claiming
container compatibility. Use an isolated checkout and stubbed tests. Evaluate
Linux and macOS separately; never treat Linux adapter tests as Apple execution.
Keep long native and Docker jobs independent with an always-running result gate.
