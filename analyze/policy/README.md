# One-run analysis policy

Run the policy with Node 22.18 or later from the repository checkout. The CLI reads one JSON request from stdin and writes one JSON result to stdout.

```sh
node analyze/policy/main.ts <<'JSON'
{
  "run": {
    "id": "run-fixture",
    "threadId": "thread-fixture",
    "sessionId": "session-fixture",
    "startedMs": 1700000000000,
    "completedMs": 1700000010000
  },
  "events": [
    {
      "eventId": "start",
      "sessionId": "session-fixture",
      "callId": "tool",
      "kind": "function_call",
      "timestampMs": 1700000001000
    },
    {
      "eventId": "end",
      "sessionId": "session-fixture",
      "callId": "tool",
      "kind": "function_call_output",
      "timestampMs": 1700000003000
    }
  ]
}
JSON
```

The input supplies one run with an established thread and session binding. The policy attributes an endpoint when its session matches and its integer UTC millisecond clock falls inside the inclusive run window. A pair crossing the window leaves the endpoint outside the window unknown. The input clocks must be JavaScript-safe integers. The CLI rejects an empty run identifier, thread identifier or session identifier, or a reversed run window, with a nonzero exit and no JSON result.

The policy emits one interval of kind `function_call` per observed in-scope call ID. Distinct event IDs claiming the same endpoint make that endpoint ambiguous, even when their clocks agree. Exact repeats of an event ID and its normalized fields are idempotent. Reusing an event ID with any conflicting normalized field blocks a duration for every affected in-scope call, including where one conflicting claim comes from outside the window or session. A missing, ambiguous, or disputed endpoint is null. For reversed clocks the policy retains the observed clocks and emits a null duration. Overlapping intervals retain their individual durations.

The policy orders intervals and findings by call ID. Every unmeasured interval has one reason in `findings`. Coverage counts distinct event IDs with an in-scope claim in `events`, measured calls in `paired`, and unmeasured calls in `unknown`.

## Verification

```sh
node --test analyze/policy/main.test.ts
```

The test invokes the real CLI with synthetic events. It covers a two-second duration, overlap, scope boundaries, missing endpoints, conflicting identities, ambiguous concurrent claims, reversed clocks, signed millisecond clocks, an invalid run window, and byte-identical output after duplicate replay in reversed order.

## Runtime packaging

Build the module into an existing private build directory with `node analyze/policy/main.ts --compile "$build_directory"`. Set `PLOW_POLICY_MODULE` to the absolute path of the resulting `run.mjs` when running a packaged CLI. With that setting, runtime needs Node and the compiled policy.

## Prototype dependencies

The CLI compiles the Bend2 source into an ephemeral JavaScript module using the repository's `tooling/bend.ts`. That helper needs the pinned compiler and Base library. Use a provisioned bundle selected by `PLOW_BEND_BUNDLE` or the checkout's Git compiler cache. With neither, the helper downloads the integrity-pinned bundle. A standalone greenfield package must retain or replace the compiler helper and pinned bundle, and supply a supported Node runtime for this CLI. The policy has no imports from the existing collector, SQLite evidence pipeline, or React dashboard.

The two exact host exception paths are `analyze/policy/main.ts` for stdin/stdout, the JSON codec and compiler wiring, and `analyze/policy/main.test.ts` for the Node synthetic CLI integration test.
