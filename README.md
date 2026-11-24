# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/antoniojanjay/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/antoniojanjay/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0: a dependency-free static site generator whose `run(input)` returns byte-for-byte the same output tree as makefun-site 1.0.0, in about a third of the CPU time on the practice set. It keeps the reference semantics exactly (front matter, template dialect, Markdown subset, slug rule, report) and speeds it up with bulk HTML escaping, per-build slug/link caches, a fused Markdown lexer/renderer, and templates compiled to JavaScript functions.

## Run it

```sh
node main.ts
```

`main.ts` reads cases from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR/cases.json`) and writes `/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR/answers.json`).

---

<sub>Entered on [make.fun](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
