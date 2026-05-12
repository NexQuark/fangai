# Architecture Decision Records (optional)

Use **short** ADRs when a choice is **hard to reverse** or **confuses new contributors**.

**Template**

```markdown
# ADR-NNN: Title

## Status
Proposed | Accepted | Superseded by ADR-XXX

## Context
What forces the decision?

## Decision
What we do.

## Consequences
Positive / negative / follow-ups.
```

**When to write one**

- Switching HTTP framework, transport, or adapter API shape
- Dropping support for an agent or Node version
- Adding a second outer protocol (e.g. REST gateway beside A2A)

**When not to**

- Routine bugfixes or dependency patches

Place files as `spec/adr/001-example.md`, etc.
