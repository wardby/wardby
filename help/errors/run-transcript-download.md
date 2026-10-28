---
id: errors/run-transcript-download
title: Run transcript download refused
summary: What each refusal from a get_run_transcript download link means (link_invalid, not_found, transcript_expired, transcript_unavailable, transcript_corrupt, local_repository_refused) and what to do.
audience: operator
tags: [wardby resume, get_run_transcript, link_invalid, transcript_expired, local_repository_refused, download]
appliesTo: ">=0.7.0"
---

# Run transcript download refused

`wardby resume` downloads a run's transcript from the link
`get_run_transcript` returned. When the server refuses, it answers with JSON
`{ "error": "<code>" }`, and `wardby resume` prints what the code means.
Nothing is written to your machine.

| Code                     | HTTP | Meaning and what to do                                                                                                                                                                                                                                                            |
| ------------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `link_invalid`           | 403  | The link is malformed, was changed, was made by another server (or by a stdio server, on the HTTP route), or is older than 10 minutes. Call `get_run_transcript` again for a new link. A multi-instance HTTP deployment needs `REQUEST_STATE_KEY` set the same on every instance. |
| `not_found`              | 404  | The person the link was made for can no longer read the run, or the run has no stored transcript.                                                                                                                                                                                 |
| `transcript_expired`     | 410  | The transcript was deleted after `RUN_TRANSCRIPT_RETENTION_DAYS`.                                                                                                                                                                                                                 |
| `transcript_unavailable` | 503  | The server has no blob store configured (`BLOB_STORE`), or could not read the object. Check the blob store settings on the server process.                                                                                                                                        |
| `transcript_corrupt`     | 500  | The stored object no longer matches the SHA-256 recorded when it was stored, so the server refused to send it.                                                                                                                                                                    |

`wardby resume` also refuses a download whose bytes do not match the
server's SHA-256 header, a response larger than it accepts or with an invalid
length, and run details with control characters, and never writes a partial
file.

## local_repository_refused

Printed by `wardby resume`, not the server. The run's repository is a
`local:` folder, which names a path on the server's machine, but the link
comes from another machine. Checking it out would let that server choose any
repository on yours, so nothing was written. Run the command on the server's
machine with a link from its stdio MCP server, or pass `--here` to continue
in the current directory, or `--dir <path>` to check the run out from that
folder anyway.

Over stdio, the link points at a local port the MCP server opens while links
are in use: if `wardby resume` cannot reach it, keep your MCP client
connected and request a new link.

See [Resume Claude Code runs locally](../resume-runs-locally.md).
