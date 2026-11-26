# Contributing to Barnacles

Read [AGENTS.md](AGENTS.md) for ownership, data boundaries, and verification. Work on a topic branch and keep changes scoped to one reviewable outcome. Put source details and verification commands beside the code they cover.

For source readers and delivery joins, use synthetic fixtures for replay, incomplete input, and ambiguous attribution. Keep the real-data reproduction local and document the command, observed result, and gaps. Review evidence before sharing it publicly.

Open a scoped pull request with the change, verification, and remaining acceptance gaps. Link an existing issue if there is one. Use `Closes` for completed issues and `Refs` for partial work. Follow the pull request through merge as described in [AGENTS.md](AGENTS.md). Deployment requires separate authorization.

## Verify locally

Run `npm ci --ignore-scripts` followed by `npm run verify` from a fresh checkout. The same command runs in the hosted workflow on pull requests and on landed main. Verification builds the pinned Bend2 policy, runs integration tests with synthetic evidence, and checks owner imports. It uses a private temporary job directory. A fresh run fetches the pinned compiler and packages once when there is no installed bundle. Use `npm run verify -- collector`, `npm run verify -- evidence`, `npm run verify -- dashboard`, or `npm run test:hooks` for focused feedback.

Collector loads evidence through `evidence/index.ts`. Dashboard reads it through `evidence/read.ts`. Its verification fixture can use the loader to seed a synthetic database. Evidence and Collector may use the independent `tooling/bend.ts` compiler bootstrap. The boundary check covers static imports and re-exports, including type imports, and literal module loads in the owner directories. Generated policy loads go through the compiler bootstrap.

## Commit hook

Run these commands from each checkout or worktree:

```sh
npm ci --ignore-scripts
npm run hooks:install
```

Use Node 22.18 or later. On the first install, the setup command fetches and verifies the pinned compiler and packages into the Git common directory. It selects the tracked hooks for the current worktree. Subsequent commits compile the checked-out policies from that local bundle and compare parsed comments in the staged Git tree to the current HEAD. Rerun setup when pins change or a bundle needs repair. [Offline verification](tooling/README.md#verify-without-network-access). Existing comments may remain or be deleted. A detected rename can carry an existing comment to the new path. A copy receives no allowance.

The directory-width guard allows at most ten immediate files and ten immediate subdirectories per affected first-party directory. It checks the staged or outgoing Git tree, including affected parent directories whose immediate entries changed. Docs and extensionless files count. Symlinks count as files and submodules count as directories. Dependency and cache trees are excluded. The root has separate slots for actual `.github` and `.githooks` directories, and GitHub's immediate `.github/workflows` directory is exempt. The push hook repeats the check against the outgoing commit.

The guard adapts [Apparent's staged directory-width policy](https://github.com/tryapparent/apparent/blob/204f0dadccc55253290e1100a1ee271bfef5a361/enablement/directory-width/check.py). The [donor MIT notice](LICENSE) covers the adaptation.

The Bend2 path check reads the exception registry from the staged tree. New implementation paths, including rename and copy destinations, must use `.bend` or appear in [the exact-path registry](.githooks/bend-exceptions.json). Markdown and license files are allowed. Existing-file repairs remain possible. For a new host exception, get an explicit decision and record the concrete Bend2 limitation beside the owning code. Review changes inside approved paths for misplaced behavior. The push hook repeats the check against the committed tree.

The check covers Bend2, JS and TS, shell, SQLite, YAML, JSON and JSONC, CSS, HTML and its supported embedded code, Markdown HTML comments, Git patterns, and several other common source formats. It treats recognized shebangs as executable syntax and ignores comment-like text in strings, regexes, and documentation examples. Plain text, license text, and recognized media files carry no code comment syntax. Unsupported changed formats and parse errors require a supported parser.

Run the focused tests with `npm run test:hooks`. The hook adapts Apparent's staged snapshot and comment comparison approach. The [donor MIT notice](LICENSE) covers adapted code.

## Push hook

The same installation enables the pre-push hook. Fetch the target remote's `main` branch before feature pushes. The hook compares each outgoing ref tip with its integration base and repeats the comment check on that committed tree. It runs tests from a private snapshot of the outgoing commit, so local edits cannot affect the result.

Documentation-only changes still run the directory-width, comment, and Bend2 path checks. Collector changes also run the Collector and Dashboard suites. Evidence changes run all three product suites. Dashboard changes run its snapshot suite. Hook changes run the hook suite. Shared changes run the full verification command. Deleting a ref sends no source to verify.

The push hook reads the installed compiler bundle and sources locked Node dependencies from the npm cache populated by setup. The tests run from the outgoing commit using the same command as local and hosted verification.
