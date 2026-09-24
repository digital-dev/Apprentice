# Security Policy

## Supported Versions

Apprentice is pre-1.0 (currently `0.x-beta`). Only the latest release is
supported — please update before reporting an issue.

## Reporting a Vulnerability

Please **do not** open a public issue for a security vulnerability.

Instead, use GitHub's private vulnerability reporting for this repository:
open the **[Report a Vulnerability](../../security/advisories/new)** form
under the Security tab. This reaches maintainers privately and lets us
coordinate a fix before any public disclosure.

Include what you'd include in any good bug report: the affected version,
reproduction steps, and the impact as you understand it. We'll acknowledge
reports as soon as we can and keep you updated as we work through it.

## Scope

Apprentice reads and writes the memory of a game process you explicitly
attach it to, on your own machine — it makes no network requests of its own
(Cheat Table import/export and the game library only read/write local
files). Relevant reports include things like: a crafted `.CT` table or
`games/*.json` profile causing memory corruption or arbitrary code execution
in Apprentice itself (not the game being cheated), a way for the MCP server
to write to a game process despite being documented read-only, or a
dependency vulnerability that's actually reachable from this codebase.

Out of scope: anything requiring the game itself to be malicious or
compromised first, and general "this tool can modify game memory" reports —
that's the product.
