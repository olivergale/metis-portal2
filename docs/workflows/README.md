# GitHub Workflows - Manual Installation Required

This directory contains GitHub Action workflow files that cannot be automatically deployed due to GitHub API security restrictions.

## Why Manual Installation?

GitHub's API requires the `workflow` scope on Personal Access Tokens to create or modify files in `.github/workflows/`. This is a security measure to prevent unauthorized workflow modifications.

## Installation Instructions

### UTF-8 Corruption Check (WO-0501)

**Purpose**: Detect multiply-encoded UTF-8 sequences that cause catastrophic file bloat (as seen in WO-0480 and WO-0500).

**Installation**:
```bash
cp docs/workflows/utf8-check.yml .github/workflows/utf8-check.yml
git add .github/workflows/utf8-check.yml
git commit -m "Add UTF-8 corruption check workflow (WO-0501)"
git push
```

**What it does**:
- Runs on every push to `main` that changes TypeScript/JavaScript files
- Scans changed files for the corruption pattern: `(\xC3[\x82-\x83]){4,}` (ÃÂÃÂÃÂÃÂ...)
- **BLOCKS deployment** if corruption is detected
- Provides clear error message with corrupted file list and remediation steps

**Why it's critical**:
- WO-0480: tools.ts bloated from 25KB to 811KB, blocking all builder execution
- WO-0500: qa-review/index.ts bloated from 15KB to 101KB, causing cascading QA failures
- Root cause: `github_edit_file` corrupts multi-byte UTF-8 characters during base64 encode/decode

## Verification

After installation, verify the workflow is active:
1. Go to https://github.com/olivergale/metis-portal2/actions
2. Look for "UTF-8 Corruption Check" in the workflow list
3. Push a test change to trigger the workflow

## Alternative: Integrate into Existing Workflow

If you prefer not to create a separate workflow, you can integrate the corruption check into `.github/workflows/deploy-functions.yml` as a pre-deployment step. See the corruption check step in `utf8-check.yml` for the exact bash script.
