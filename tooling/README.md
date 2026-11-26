# Verification and offline hook boundaries

`npm run verify -- hooks collector evidence dashboard` compiles [verification.bend](verification.bend) to select test scopes and files and enforce owner import permissions. [check-boundaries.ts](check-boundaries.ts) reads the files and decodes import nodes through Tree-sitter. [verify.ts](verify.ts) runs the selected Node tests. `npm run demo` compiles [demo.bend](../examples/demo.bend) to make the synthetic delivery, workflow and rollout timelines. [demo.ts](../examples/demo.ts) obtains the wall clock, encodes the fixture records for the external interfaces and runs the existing importers and snapshot builder.

The verification command, including the hooks-only suite, uses the checksum-pinned compiler download. A Git commit and the pre-push checks before test execution use only Node, Git and the npm-installed parsers. Documentation-only pushes still skip verification. The push test runs a real verification command in a committed snapshot and exercises a forbidden import, a failed test, and a successful push whose working tree contains an uncommitted failing test.

## Remaining host paths

These paths are already registered in [bend-exceptions.json](../.githooks/bend-exceptions.json). The compiler can express these offline decisions. The existing hook installation needs a way to deliver the compiler or a compiled policy before the offline hook runs.

| Path | What remains |
| --- | --- |
| [tooling/bend.ts](bend.ts) | Fetch the pinned compiler sources, verify their SHA-256 digests, invoke the compiler and import its transient JS output. This bootstrap runs before any Bend module exists. |
| [tooling/check-directory-width.ts](check-directory-width.ts) | Read staged or committed Git trees and compare the index identity after the check. The offline code still computes first-party exclusions, affected parent directories, file and subdirectory counts, root allowances and width violations. |
| [.githooks/pre-commit](../.githooks/pre-commit) | Check that Node and parser dependencies are installed and run the three offline checks. |
| [.githooks/check-comments.ts](../.githooks/check-comments.ts) | Read Git diff and blob data and coordinate the parsers. The offline code still decides which staged file modes to check, when old or renamed blobs grant allowance, and whether the staged comment multiset exceeds that allowance. |
| [.githooks/comment-syntax.ts](../.githooks/comment-syntax.ts) | Bind Tree-sitter WASM, YAML, Markdown and HTML parsers. Offline code still selects grammars and embedded syntax and recognizes Bend comments and literal escapes, Git-pattern comments and shebangs. |
| [.githooks/check-bend-paths.ts](../.githooks/check-bend-paths.ts) | Read the staged or committed registry and changed paths. The offline code still checks exact-path exceptions and the Bend, Markdown and license filename rules. |
| [.githooks/pre-push](../.githooks/pre-push) | Read outgoing refs, look up integration bases, run checks and materialize test snapshots. The code still decides which refs to skip, which base to request, whether a change is documentation-only and which test scopes to request before launching the verification command. |
| [.githooks/snapshot.ts](../.githooks/snapshot.ts) | Materialize immutable Git blobs using exclusive file creation. Git object ID, path-component, blob type and mode checks still run locally, before verification and its compiler bootstrap. |
| [.githooks/bend-exceptions.json](../.githooks/bend-exceptions.json) | Keep the exception manifest readable by the offline staged-tree check. |
| [.githooks/comments.test.ts](../.githooks/comments.test.ts), [.githooks/push.test.ts](../.githooks/push.test.ts), [tooling/tests/directory-width.test.ts](tests/directory-width.test.ts) | Synthetic fixtures, subprocess setup and assertions spanning Git, Node and filesystem entry points. |
| [tooling/check-boundaries.ts](check-boundaries.ts), [tooling/verify.ts](verify.ts), [examples/demo.ts](../examples/demo.ts) | Runtime, parser and wire-format bindings for the Bend policies. |

## Reproduce the offline packaging limit

The compiler revision and the five required source digests are in [bend.ts](bend.ts). The usable local compiler consists of `main.ts`, `bend.ts`, `comp.ts`, `safe.ts` and `base.bend` from that revision. The npm lock contains the syntax bindings but does not contain these files. `npm ci --ignore-scripts` skips lifecycle scripts and `npm run hooks:install` only writes Git configuration. The bootstrap downloads the compiler into scratch and deletes the source bundle after compilation. Generated modules stay out of Git.

Use a disposable checkout in Clanker's private temporary directory and an npm cache populated by `npm ci --ignore-scripts`. On Linux, prefix the commands below with `strace -f -e trace=connect -e inject=connect:error=ENETUNREACH` to deny connections to each command and its subprocesses.

1. Run `npm ci --offline --ignore-scripts --no-audit --no-fund` and `npm run hooks:install`. Stage a new `tooling/offline-proof.bend` containing `def proof() -> U32: 1` without any other staged changes. Run `git -c commit.gpgsign=false commit -m "offline proof"` with connections denied. The installed hook accepts the commit.
2. Deny connections for `node tooling/check-boundaries.ts`. The normal bootstrap fails at the fetch for `raw.githubusercontent.com`. The lock and Git configuration supply no offline compiler input.
3. Fetch the five pinned files while online, verify each with `sha256sum --check` using the digests in `bend.ts`, and put them together in a private job directory. Set `policy` to the absolute path of `tooling/verification.bend`, set `output` to an absolute `.mjs` path in an empty subdirectory, and run the following from the directory holding the five files with connections denied.

   ```sh
   BEND_NO_TELEMETRY=1 BEND_HUB=http://127.0.0.1:1 BEND_LIB="$PWD/bend-lib" BENDTT='' \
     strace -f -e trace=connect -e inject=connect:error=ENETUNREACH \
     node --experimental-transform-types --input-type=module -e '
       import { load } from "./main.ts";
       import { pathToFileURL } from "node:url";
       import { writeFileSync } from "node:fs";
       const [input, output] = process.argv.slice(1);
       const { source } = await load(pathToFileURL(input).href, null, () => {
         throw Error("Expected local source");
       });
       writeFileSync(output, source);
     ' "$policy" "$output"
   ```

4. From the output directory, deny connections for `node --input-type=module -e 'import policy from "./verification.mjs"; if (!policy.is_test("fixture.test.ts") || policy.is_test("fixture.ts")) process.exit(1)'`. Local compilation and execution both succeed without any `connect` calls. The generated module is self-contained for this policy.

Moving the remaining rules requires a supported setup step that provisions the pinned source bundle or builds an offline policy. That setup has to keep the artifact synchronized with the hook source and handle a missing artifact on a fresh install. Neither the current npm setup nor the current Git installer provides that step.
