# Git Hooks

This directory contains custom git hooks for the metis-portal2 repository.

## Available Hooks

### pre-commit

Scans staged TypeScript files (`.ts`) for non-ASCII characters (bytes 0x80-0xFF) and blocks commits if found.

**What it checks:**
- Em-dashes (—) should be double-hyphens (--)
- Curly quotes (' ' " ") should be straight quotes (' ")
- Any other Unicode characters that could cause encoding issues

**Output format:**
```
ERROR: Non-ASCII characters found in supabase/functions/example/index.ts:
  Line 42: // v10: Fix auto-QA — deployment validation
    c3 a2 e2 80 94
```

## Installation

To enable these hooks in your local repository:

```bash
cd /path/to/metis-portal2
git config core.hooksPath .github/hooks
chmod +x .github/hooks/pre-commit
```

**Verify installation:**
```bash
git config --get core.hooksPath
# Should output: .github/hooks
```

## Bypass (Emergency Use Only)

If you need to bypass the pre-commit hook in an emergency:

```bash
git commit --no-verify -m "Your message"
```

**Warning:** Bypassing the hook can introduce UTF-8 corruption that breaks CI builds and agent execution. Only use `--no-verify` if you are certain the files are safe.

## Troubleshooting

**Hook not running:**
1. Check that `core.hooksPath` is set: `git config --get core.hooksPath`
2. Ensure the hook is executable: `chmod +x .github/hooks/pre-commit`
3. Verify you're in the repo root when committing

**False positives:**
If the hook blocks a commit that you believe contains only ASCII:
1. Check the file encoding: `file supabase/functions/example/index.ts`
2. Re-save the file with UTF-8 encoding
3. Use `iconv` or `dos2unix` to clean line endings if needed

**Hook fails with "command not found":**
The hook requires `grep` with Perl regex support (`-P` flag). On macOS, install GNU grep:
```bash
brew install grep
# Add to PATH in ~/.zshrc or ~/.bash_profile:
export PATH="/usr/local/opt/grep/libexec/gnubin:$PATH"
```

## Manual Scan

To manually scan all TypeScript files without committing:

```bash
find supabase/functions -name "*.ts" -type f -exec grep -Hn '[\x80-\xFF]' {} \;
```

To scan and show hex codes:

```bash
find supabase/functions -name "*.ts" -type f | while read f; do
  if grep -q '[\x80-\xFF]' "$f"; then
    echo "=== $f ==="
    grep -Pn '[\x80-\xFF]' "$f"
  fi
done
```
