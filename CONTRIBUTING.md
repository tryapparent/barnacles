# Contributing to Barnacles

Read [AGENTS.md](AGENTS.md) for ownership, data boundaries, and verification. Work on a topic branch and keep changes scoped to one reviewable outcome. Put source details and verification commands beside the code they cover.

For source readers and delivery joins, use synthetic fixtures for replay, incomplete input, and ambiguous attribution. Keep the real-data reproduction local and document the command, observed result, and gaps. Review evidence before sharing it publicly.

Open a scoped draft pull request with the change, verification, and remaining acceptance gaps. Link an existing issue if there is one. Use `Closes` for completed issues and `Refs` for partial work. Merge and deployment follow the authorization for the task.

## Commit hook

Run these commands from each checkout or worktree:

```sh
npm ci --ignore-scripts
npm run hooks:install
```

Use Node 22.18 or later. The installer selects the tracked hook directory in the current worktree. The hook runs offline and compares parsed comments in the staged Git tree to the current HEAD. Existing comments may remain or be deleted. A detected rename can carry an existing comment to the new path. A copy receives no allowance.

The check covers Bend2, JS and TS, shell, SQLite, YAML, JSON and JSONC, CSS, HTML and its supported embedded code, Markdown HTML comments, Git patterns, and several other common source formats. It treats recognized shebangs as executable syntax and ignores comment-like text in strings, regexes, and documentation examples. Plain text, license text, and recognized media files carry no code comment syntax. Unsupported changed formats and parse errors require a supported parser.

Run the focused tests with `BARNACLES_TEST_DIRECTORY="$job" npm run test:hooks` from a private job directory. The hook adapts Apparent's staged snapshot and comment comparison approach. The [donor MIT notice](collector/APPARENT-LICENSE) covers adapted code.
