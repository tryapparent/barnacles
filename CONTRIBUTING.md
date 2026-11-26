# Contributing to Barnacles

Read [AGENTS.md](AGENTS.md) for ownership, data boundaries, and verification. Work on a topic branch and keep changes scoped to one reviewable outcome. Put source details and verification commands beside the code they cover.

For source readers and delivery joins, use synthetic fixtures for replay, incomplete input, and ambiguous attribution. Keep the real-data reproduction local and document the command, observed result, and gaps. Review evidence before sharing it publicly.

Open a scoped pull request with the change, verification, and remaining acceptance gaps. Link an existing issue if there is one. Use `Closes` for completed issues and `Refs` for partial work. Follow the pull request through merge as described in [AGENTS.md](AGENTS.md). Deployment requires separate authorization.

## Commit hook

Run these commands from each checkout or worktree:

```sh
npm ci --ignore-scripts
npm run hooks:install
```

Use Node 22.18 or later. The installer selects the tracked hook directory in the current worktree. The hook runs offline and compares parsed comments in the staged Git tree to the current HEAD. Existing comments may remain or be deleted. A detected rename can carry an existing comment to the new path. A copy receives no allowance.

The check covers Bend2, JS and TS, shell, SQLite, YAML, JSON and JSONC, CSS, HTML and its supported embedded code, Markdown HTML comments, Git patterns, and several other common source formats. It treats recognized shebangs as executable syntax and ignores comment-like text in strings, regexes, and documentation examples. Plain text, license text, and recognized media files carry no code comment syntax. Unsupported changed formats and parse errors require a supported parser.

Run the focused tests with `BARNACLES_TEST_DIRECTORY="$job" npm run test:hooks` from a private job directory. The hook adapts Apparent's staged snapshot and comment comparison approach. The [donor MIT notice](collector/APPARENT-LICENSE) covers adapted code.

## Push hook

The same installation enables the pre-push hook. Fetch the target remote's `main` branch before feature pushes. The hook compares each outgoing ref tip with its integration base and repeats the comment check on that committed tree. It runs tests from a private snapshot of the outgoing commit, so local edits cannot affect the result.

Documentation-only changes run the comment check. Collector or evidence changes also run the Bend2 integration tests. Hook changes run the hook tests. Changes to shared inputs such as the npm manifest or lockfile run both suites. Deleting a ref sends no source to verify.

The hook and collector suites install their locked dependencies from the local npm cache populated by setup. The collector suite fetches the existing checksum-pinned Bend2 compiler. Both suites run locally against synthetic inputs.
