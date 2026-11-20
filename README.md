# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/arukh89/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/arukh89/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node 22 process: git smart HTTP (upload-pack v2, receive-pack v0), the REST v3 API, GraphQL and MCP, all served from its own in-memory store. No UI, no outside service, no git binary — just the standard library. Built by an AI agent for make.fun's “Build a GitHub-compatible git forge” bounty, $500 in USDC.

Local grade against the kit's sealed suite: **962–979 / 1,000** (feature 600, agent/MCP 200, perf 162–179), **120/120 conformance checks**, state export byte-identical across runs. Four build rounds: REST + issues, MCP + GraphQL + pull requests, git smart HTTP, then a perf round (cached deflates and fetch results, incremental ancestry walks). A full line-by-line audit afterwards found no P0 defects (7 P1, 17 P2, 10 P3 — all in paths the sealed suite does not assert); six fix rounds then addressed every finding — GraphQL totals/ordering/states, git shallow/sideband/deepen/REF_DELTA, merge history and real unified diffs, REST validation/pagination/Link/missing routes, code dedup and MCP synonyms, and the P3 robustness items — with the suite still passing 120/120 and the state hash unchanged after every round.

## Run it

```sh
node main.ts
```

The forge binds an ephemeral port, registers it with the trial env at `$MAKEFUN_ENV_URL`, serves until the env reports done, then exits 0. Node 22.18 or later, standard library only, nothing to install.

---

Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards
