---
id: errors/tunnel-session-ended
title: Run session ended (tunnel_session_ended)
summary: The token is valid but its run's session is over.
audience: operator
tags: [error, coding-agents, proxy, tunnel, tunnel_session_ended]
appliesTo: ">=0.10.1"
---

# tunnel_session_ended

`tunnel_session_ended` (HTTP 403) is an answer from the coding proxy's [CONNECT tunnel](../coding-proxy-tunnel.md). The body is fixed JSON and never repeats the host, the token or any header value.

The run's session was cancelled, finished or passed its deadline, so its tunnel token no longer opens tunnels. A tunnel that is already open when this happens is closed, and its audit record shows the outcome `session_ended`.

Fix: nothing for the run; the session is over. If a run stopped earlier than expected, look at why its session ended (cancellation, budget or deadline) in the run's record.
