# A2A Protocol v1.0.1 — Vendored Specification

This directory is a vendored snapshot of the A2A (Agent2Agent) protocol
specification at version **v1.0.1**, for offline reference and as the
source of truth for fangai's A2A compliance work.

## Source

- Repository: https://github.com/a2aproject/A2A
- Tag:         v1.0.1
- Commit SHA:  see `VERSION`
- License:     Apache-2.0 (see `LICENSE`)

## Contents

- `specification/` — Formal A2A protocol artifacts (protobuf + JSON schema)
- `topics/` — Prose documentation (agent discovery, task lifecycle, streaming, etc.)
- `CHANGELOG.md` — Upstream release notes (use to track v0.3.0 → v1.0 migration)
- `LICENSE` — Apache 2.0 license text

## Updating

To re-vendor at a newer A2A release:

```bash
# 1. Clone upstream at the target tag
git clone --depth 1 --branch vX.Y.Z https://github.com/a2aproject/A2A /tmp/a2a

# 2. Replace the vendored snapshot
cd <fangai-root>
rm -rf spec/a2a-v1/specification spec/a2a-v1/topics
cp -r /tmp/a2a/specification spec/a2a-v1/specification
cp -r /tmp/a2a/docs/topics spec/a2a-v1/topics
cp /tmp/a2a/LICENSE spec/a2a-v1/LICENSE
cp /tmp/a2a/CHANGELOG.md spec/a2a-v1/CHANGELOG.md

# 3. Bump VERSION
echo "A2A Protocol Specification vX.Y.Z" > spec/a2a-v1/VERSION
echo "Upstream commit: $(git -C /tmp/a2a rev-parse HEAD)" >> spec/a2a-v1/VERSION

# 4. Commit
git add spec/a2a-v1/
git commit -m "chore(spec): bump vendored A2A spec to vX.Y.Z"
```

## License

The vendored contents are © their respective authors and licensed under
Apache-2.0. See `LICENSE` for the full text. The vendoring mechanism in
this repository is permitted under Apache-2.0 §4 (reproduction and
distribution with notice).
