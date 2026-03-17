---
name: add-context-hub
description: >
  Add Context Hub (chub) to NanoClaw agents. Installs the @aisuite/chub CLI globally
  in the container so agents can fetch curated, versioned API docs instead of
  hallucinating. Per-group annotations persist in the group workspace.
---

# Add Context Hub

Installs the `chub` CLI ([@aisuite/chub](https://github.com/andrewyng/context-hub))
in the agent container and deploys the agent-facing skill so all groups get
auto-triggered API doc fetching.

## Phase 1: Pre-flight

Check if already applied:

```bash
grep -q "@aisuite/chub" container/Dockerfile && echo "Already applied" || echo "Not applied"
```

If already applied, skip to Phase 3 (Verify).

Also confirm the skill doc exists:

```bash
test -f container/skills/context-hub/SKILL.md && echo "Skill doc exists" || echo "Missing"
```

## Phase 2: Apply Changes

### 2a. Update the Dockerfile

In `container/Dockerfile`, find the line:

```
RUN npm install -g agent-browser @anthropic-ai/claude-code
```

Replace with:

```
RUN npm install -g agent-browser @anthropic-ai/claude-code @aisuite/chub
```

Then add immediately after (before `WORKDIR /app`):

```dockerfile
# Persist chub annotations per-group (symlink to mounted group workspace)
RUN ln -s /workspace/group/.chub /home/node/.chub
```

### 2b. Create the agent-facing skill doc

Create `container/skills/context-hub/SKILL.md` with the get-api-docs skill content
(search → get → annotate → feedback workflow with `allowed-tools: Bash(chub:*)`).

### 2c. Rebuild the container

```bash
./container/build.sh
```

If the build fails with a stale cache, force a clean rebuild:

```bash
# Docker:
docker builder prune -f && ./container/build.sh
# Apple Container:
container builder stop && container builder rm && container builder start && ./container/build.sh
```

Verify `chub` is installed:

```bash
docker run --rm --entrypoint chub nanoclaw-agent:latest --version
```

### 2d. Restart the service

```bash
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux:
systemctl --user restart nanoclaw
```

## Phase 3: Verify

### Check CLI availability

```bash
docker run --rm --entrypoint chub nanoclaw-agent:latest search "stripe" --json 2>&1 | head -20
```

### Check symlink

```bash
docker run --rm nanoclaw-agent:latest bash -c "ls -la /home/node/.chub"
```

Should show `/home/node/.chub -> /workspace/group/.chub`.

### Check skill auto-discovery

Ask the agent in any registered chat:
> How do I use the Stripe API?

The agent should invoke the `get-api-docs` skill and run `chub search` then `chub get`.

### Check annotation persistence

After the agent annotates a doc, check the group workspace on the host:

```bash
ls groups/{folder}/.chub/
```

## Troubleshooting

### `chub: command not found`

Container image not rebuilt. Run `./container/build.sh` and restart.

### Annotations not persisting

Check the symlink inside the container:
```bash
docker run --rm nanoclaw-agent:latest bash -c "ls -la /home/node/ | grep chub"
```
Should show a symlink, not a directory. If wrong, force a clean rebuild.

### Skill not auto-triggering

The skill doc syncs on container startup via `container-runner.ts`. Verify:
```bash
ls data/sessions/{group-folder}/.claude/skills/context-hub/
```
Should contain `SKILL.md`. If missing, restart the service.
