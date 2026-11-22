# mend

![](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)![](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mr1229751/mend/rank.svg)![](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mr1229751/mend/reward.svg)

One patch tool for every AI edit format. `mend` is a command-line tool (Node 22, TypeScript, stdlib only) that applies AI-written edits in four formats — unified diff, SEARCH/REPLACE blocks, V4A patch, and JSON edit lists — with three-tier matching (exact, trailing-whitespace, trim + re-indent), atomic application (one failed edit means no file is written), and byte-exact deterministic output.

Entry for the make.fun bounty [hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` omitted or `-` reads the patch from stdin. Exit 0 lists the applied changes (`A`/`D`/`M`/`R` lines) and an `ok:` summary; exit 1 lists every failed edit and writes nothing; exit 2 is a single-line usage/format/parse error. See `SPEC.md` for the full format specification.
