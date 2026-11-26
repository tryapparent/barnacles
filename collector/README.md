# Collector

The first entry point will be a one-shot TypeScript command on Node 22.18+. Run it locally with explicit repository, time window, and input references. Source readers own authentication, pagination, caps, timeouts, and conversion to allowlisted records. They return coverage alongside the records so a failed read cannot appear as an empty source.

| Source | Initial boundary |
| --- | --- |
| T3 | Import metadata from supported thread and PR-link tools. Retain source identity, thread start, status, run clocks, explicit PR links, and origin when established. Omit messages and titles. |
| Codex | Read selected local rollouts. Pair stable call and result IDs and preserve a separate endpoint for a correlated async process. Discard raw arguments and outputs after deriving timing. |
| GitHub | Read PR and commit metadata, exact Actions attempts and jobs, and release assets. Check tag ancestry where applicable. Verify the intended asset with a bounded anonymous range request when the surface is public. Store publication and access observation timestamps. |

## Apparent donor code

Use the reviewed upstream revision `ed8e448f6b7d0826b1922a97fcef9691c9f5676f` as the starting point. Adapt narrow portions and their relevant synthetic tests as each reader lands. Preserve the original license and notices on copied code. Barnacles should run from its own checkout.

- [Rollout census](https://github.com/tryapparent/apparent/blob/ed8e448f6b7d0826b1922a97fcef9691c9f5676f/enablement/timing/census.ts) and [yielded poll readers](https://github.com/tryapparent/apparent/tree/ed8e448f6b7d0826b1922a97fcef9691c9f5676f/enablement/timing/yielded-polls) supply envelope pairing and conservative process correlation.
- [GitHub reader](https://github.com/tryapparent/apparent/blob/ed8e448f6b7d0826b1922a97fcef9691c9f5676f/enablement/timing/review/github.ts) and [snapshot normalization](https://github.com/tryapparent/apparent/blob/ed8e448f6b7d0826b1922a97fcef9691c9f5676f/enablement/timing/review/snapshots.ts) supply attempt/SHA validation, job/step clocks, and carried-job handling. A jobless workflow supplies no runner-queue clock.
- [Release guidance](https://github.com/tryapparent/apparent/blob/ed8e448f6b7d0826b1922a97fcef9691c9f5676f/composition/enablement/release/README.md) supplies the channel and artifact semantics. Keep the Apparent release tag convention in its source adapter.

Apparent's review ranking and dispatch orchestration serve a different workflow. Barnacles has no dependency on its desktop stack, CI hooks, or dispatch tooling.
