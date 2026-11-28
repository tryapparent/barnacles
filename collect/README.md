# Historical fixture collection

The fixture projector reads the two files in [fixtures](fixtures/) and writes normalized, newline-delimited JSON to a private candidate spool. The TypeScript host decodes JSON and ISO timestamps, calls the compiled policy, and writes files. [Bend2](project.bend) checks identifiers and clocks, binds Codex events to the observed session, and constructs a fresh allowlisted JSON body. Filename, working directory, prompt, tool name, arguments, and output stay out of the spool.

Codex event IDs are the session plus the original one-based line number. Replaying the same retained input preserves each ID. The fixture assumes one append-only rollout per session and makes no identity claim for rewritten or forked files. It omits malformed or unbound events and rejects conflicting session metadata before writing the spool. The T3 fixture declares the native session binding directly.

Alloy reads the spool with file positions and an OTLP sending queue on its named data volume. Its [River configuration](alloy/config.txt) maps normalized clocks onto OTLP timestamps and adds observation time and identifiers as metadata. The T3 record is indexed at run completion. The low-cardinality resource attribute `plow_source` becomes a Loki stream label. High-cardinality identifiers stay in the JSON and in structured metadata. The tracked file uses a text extension for repository syntax checking and is mounted as `config.alloy`.

Run the focused projector test and the Compose fixture proof from the repository root.

```sh
node --experimental-transform-types --test collect/fixture.test.ts
bash infra/lgtm/check.sh
```

The projector uses Node 22 and [the pinned compiler bootstrap](../tooling/bend.ts), including its Bend Base, JSON and Bytes package pins. Keep or move that bootstrap and bundle when retiring the prototype tooling. The fixture path requires no SQLite, legacy collector, React dashboard, or custom MCP server. The fixture exercises the shape consumed by Alloy and Loki.


## One T3 run

Use an existing read-scoped bearer file. The adapter reads the latest bounded projection, requires exactly one strong local Codex session binding and the exact completed run, and prints one allowlisted JSON record. To stage it for Alloy, redirect stdout into a new spool using the T3 filename `t3.jsonl`. The reader supports a single run per request. Older runs that fall outside the snapshot require a paginated source adapter.

```sh
PLOW_T3_ORIGIN=https://t3.example.invalid PLOW_T3_READ_TOKEN_FILE=/private/t3-read-token \
  node collect/t3/read.ts THREAD_ID RUN_ID
```

`node --test collect/t3/read.test.ts` exercises the CLI and authentication against a synthetic HTTP origin.
