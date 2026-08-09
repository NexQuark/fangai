# Migration: fangai v0.3.0 → A2A v1.0.1

Generated from upstream A2A v1.0.0 release notes (2026-03-12) +
v1.0.1 patch notes (2026-05-26).

## Breaking changes that affect fangai

| # | Upstream change | fangai action |
|---|---|---|
| 1 | `TaskStatusUpdateEvent.final` field removed | Remove from cancel endpoint and SSE event writing (use `status.state` in terminal set instead) |
| 2 | `AgentCard.supportsAuthenticatedExtendedCard` → `supportsExtendedAgentCard` | Rename in agent card builder |
| 3 | `extendedAgentCard` moved to `AgentCapabilities` | Remove top-level `extendedAgentCard` if present |
| 4 | Spelling "canceled" standardized (American) | Already correct in fangai ✓ |
| 5 | Switch to non-complex IDs in requests | Already using UUIDv4 ✓ |
| 6 | Content-Type: prefer `application/a2a+json` | Configure body parser to accept + respond with this |
| 7 | OAuth 2.0 flows: remove implicit/password, add device_code + PKCE | Update securitySchemes definitions if any |
| 8 | Enum format aligned with ADR-001 ProtoJSON | TypeScript SDK handles automatically |
| 9 | `tasks/list` method added | Optional: implement or document gap |
| 10 | `agent.json` → `agent-card.json` well-known URI | Already using `.well-known/agent-card.json` ✓ |
| 11 | `TaskPushNotificationConfig` + `PushNotificationConfig` merged | Defer (fangai doesn't implement push) |
| 12 | gRPC GA + multi-tenant `scope` field | Defer (fangai is HTTP only) |
| 13 | `Part` message flattened (FilePart + DataPart merged) | TypeScript SDK handles automatically |
| 14 | URL bindings lost `v1s` prefix | Inspect server.ts; HTTP routes unchanged |
| 15 | `protocolVersion` is required in AgentCard | Bump `0.3.0` → `1.0` |
| 16 | gRPC `state_transition_history` removed | N/A for fangai (HTTP only) |
| 17 | LF prefix added to protobuf package | N/A for fangai (uses HTTP, not proto) |

## SDK upgrade

- Current: `@a2a-js/sdk@0.3.13`
- Target:  `@a2a-js/sdk@^1.0.0` (npm `latest` = `1.0.1`)

Expect TS compile errors in `src/server.ts` from type renames, new
required `protocolVersion` value, and removed `final` field. Fix as
they come up via `tsc --noEmit`.
