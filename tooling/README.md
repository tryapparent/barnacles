# Verification and offline hooks

`npm run hooks:install` verifies the pinned Bend2 compiler and package sources, installs them under `barnacles-bend` in Git’s common directory, and selects the tracked hooks for the current worktree. Run it once after installing the npm dependencies. A fresh install fetches the inputs named in [bend.ts](bend.ts). Worktrees share the verified bundle and each worktree selects its own hooks. Run the installer again when the source pins change or the installed files need repair.

The hooks verify the SHA-256 digests of their compiler and package sources on each use, then build the checked-out Bend2 policies in disposable scratch space. The pre-push hook passes the verified bundle to the outgoing commit’s test snapshot. That snapshot installs its locked Node parser dependencies from the npm cache. Git still uses the configured remote transport for the push itself.

The installer and verification can also read a complete local bundle through the absolute path in `BARNACLES_BEND_BUNDLE`. The same pinned digests apply. In a fresh CI checkout, `npm run verify` provisions those inputs once and shares them across its integration tests. Generated modules and the installed bundle stay outside the tracked tree.

## Policy and host interfaces

- [Rules](../.githooks/policy/rules.bend) handles Git object IDs, allowable comment counts, push scope selection, and snapshot entry admission. [Paths](../.githooks/policy/paths.bend) parses the staged JSON exception registry with Bend Kit and matches approved paths. Registry keys are unique and values are arrays of path strings.
- [Directory width](../.githooks/policy/width.bend) limits affected directories from the committed or staged tree. [Syntax](../.githooks/policy/syntax.bend) selects grammars and recognizes lexical comment cases. The [syntax host](../.githooks/comment-syntax.ts) manages the installed Tree-sitter WASM, YAML, Markdown, and HTML parser APIs and passes parser facts to Bend2.
- The hook and snapshot hosts read raw Git records and detect index changes, materialize immutable blobs, invoke external programs, and present diagnostics. [Verification](verification.bend) selects suites, test files, and owner import permissions. [The verification host](verify.ts) builds the policy, walks directories, and runs the Node integration tests.

## Bend2 packages

The registry parser uses [bend-kit-json 0.7.3.0](https://hub.bend-lang.org/package/0x419ec39802735c4664960ab4b9d962e5.json). The bootstrap pins the full SHA-256 of each imported file and the content hashes behind the codec’s named Bytes and F64 imports. The [Bend Kit source and license](https://github.com/paymog/bend-kit) and [BendHub package guide](https://hub.bend-lang.org/guide) document how the upstream packages are distributed. Trace IDs also use the pure [Element SHA-256 implementation](https://hub.bend-lang.org/0x29d6f1ff259add9ea6c8f213fda12377/sha256.bend). Its pinned Apache-2.0 license and the licenses supplied by the JSON package inputs are part of the local bundle.

[Bend Kit HTTP](https://github.com/paymog/bend-kit/tree/main/http) uses Wire’s native C or Bun FFI effects. [Element TLS](https://github.com/jonasporto/element-bend-libs/tree/main/packages/element-tls13) provides a pure Bend TLS state machine with networking supplied separately. The [SQLite binding](https://github.com/subtleGradient/bend-over/tree/main/packages/sqlite) provides native file-backed transactions and a separate Wasm lane. Barnacles’ current Node runtime uses established HTTPS and SQLite adapters for those interfaces. Tree-sitter supplies the exact JS, Bash, and SQL nodes required by the collectors and hooks. The pinned [File and Process interfaces](https://github.com/bendlang/bend/blob/9c586f094f4fc88bef440dc8b4d77a2f92c257cc/bend2/base.bend#L220-L399) support standalone Bend I/O. The Node adapters preserve raw Git pathname bytes and support file metadata and nonblocking open for rollout admission.

## Verify without network access

Populate the npm cache and run `npm run hooks:install` first. On Linux, run the actual commit, local push, and verification fixtures with connections denied.

```sh
strace -f -qq -e trace=connect -e inject=connect:error=ENETUNREACH npm run test:hooks
```

The suite exercises a successful installed commit and local push, missing and damaged compiler data, an invalid staged registry, comment multiplicity, an overwide outgoing tree, and verification of the outgoing commit while the working tree has an unstaged failing test.
