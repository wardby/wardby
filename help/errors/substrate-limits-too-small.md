---
id: errors/substrate-limits-too-small
title: The coding run limits are too small for two Substrate actors (substrate_limits_too_small)
summary: A coding run on the experimental Substrate launcher failed at launch because, after the tool actor's share, CODING_CPUS or CODING_MEMORY_MB leaves nothing for the agent actor.
audience: operator
tags: [error, substrate, substrate_limits_too_small, job launcher, coding-agents, CODING_CPUS, CODING_MEMORY_MB]
appliesTo: ">=0.9.15"
---

# The coding run limits are too small for two Substrate actors

`substrate_limits_too_small` means the run's CPU or memory, split between its
two actors, leaves one of them nothing. The run fails at launch, before anything
is created.

A run's size is split as on the Kubernetes launcher: the tool actor gets
0.25 CPU and a third of the memory (at least 128 MiB, at most 512 MiB), and the
agent actor gets the rest of `CODING_CPUS` and `CODING_MEMORY_MB`. Set
`CODING_CPUS` above 0.25 and `CODING_MEMORY_MB` well above 128 (the defaults, 1
CPU and 2048 MiB, fit). See
[Run coding agents on Substrate](../job-launcher-substrate.md).
