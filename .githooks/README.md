# Git Hooks for metis-portal2

This directory contains custom git hooks to prevent common issues in the ENDGAME-001 workflow.

## Installation

To enable these hooks, run:

```bash
git config core.hooksPath .githooks
```

This tells git to use hooks from this directory instead of `.git/hooks`.

## Available Hooks

### pre-push

**Purpose**: Prevent CLI-vs-API race condition where local pushes overwrite GitHub API commits.

**What it does**:
1. Fetches remote refs before push
2. Checks if remote has commits not in local branch
3. Blocks push if divergence detected
4. Shows clear instructions to pull --rebase first

**Why it exists**: 
The ilmarinen CLI agent and builder agent can both make commits. If ilmarinen pushes from a stale local copy, it can overwrite builder's GitHub API commits. This happened in WO-0283 where commit 29f409c was clobbered by commit f030347.

**Bypass options** (use with caution):
- `git push --force-with-lease` - Safer, checks remote ref
- `git push --force` - Dangerous, overwrites everything

**Example workflow when blocked**:
```bash
# Hook blocks your push and shows this message
$ git push
[pre-push] ⚠️  PUSH BLOCKED: Remote has commits not in your local copy

# Fix by rebasing
$ git stash                          # Save local changes
$ git pull --rebase origin main      # Get remote commits
$ git stash pop                      # Restore local changes
$ git push                           # Now safe to push
```

## Troubleshooting

### Hook not running
- Verify installation: `git config core.hooksPath` should show `.githooks`
- Check file permissions: `ls -la .githooks/pre-push` should be executable
- Make executable: `chmod +x .githooks/pre-push`

### Hook blocking legitimate push
- Verify remote state: `git fetch && git log origin/main..HEAD`
- If you intend to overwrite: `git push --force-with-lease`

### Disable hooks temporarily
```bash
git push --no-verify
```

## Development

To test the pre-push hook without actually pushing:

```bash
# Simulate a push
echo "refs/heads/main $(git rev-parse HEAD) refs/heads/main $(git rev-parse origin/main)" | .githooks/pre-push
```

## Maintenance

Hooks are version-controlled in this repository. Changes to hooks require:
1. Update the hook script
2. Commit and push changes
3. All developers pull changes (hooks auto-update)
4. No need to reinstall unless `core.hooksPath` was unset
