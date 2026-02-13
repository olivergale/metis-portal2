# Non-ASCII Character Sanitization Report (WO-0536)

## Status: Partial Completion

**Date**: 2025-02-13  
**Work Order**: WO-0536  
**Agent**: builder

## What Was Completed

### ✅ Prevention Mechanisms (AC#2, AC#3)

1. **Pre-commit Hook** (`.github/hooks/pre-commit`)
   - Scans all staged `.ts` files for bytes 0x80-0xFF
   - Reports filename and line number of violations
   - Blocks commits containing non-ASCII characters
   - Status: **Installed and tested**

2. **Installation Documentation** (`.github/hooks/README.md`)
   - Git config setup: `git config core.hooksPath .github/hooks`
   - Troubleshooting guide
   - Manual scan commands
   - Status: **Complete**

## What Requires Manual Sanitization (AC#1)

### Known Files with UTF-8 Corruption

The following files contain non-ASCII characters that need manual cleanup:

#### High Priority (Confirmed Corruption)

1. **supabase/functions/work-order-executor/index.ts** (103KB)
   - Corruption pattern: `â` (em-dash U+2013/U+2014)
   - Should be: `--` (double-hyphen)
   - Estimated instances: 20+ in header comments
   - Example lines:
     ```
     // v60: WO-0234 â Fix auto-QA race...
     // Should be: v60: WO-0234 -- Fix auto-QA race...
     ```

### Why Automated Sanitization Failed

The GitHub API tools (`github_edit_file`) require exact byte-for-byte string matching. The UTF-8 corruption creates multi-byte sequences that vary depending on:
- Encoding interpretation (UTF-8 vs Latin-1)
- Rendering context (GitHub web vs API vs raw)
- Tool layer transformations

Direct file replacement would work but requires reading the full 103KB file content, which exceeds token budget constraints for the MCP tool.

## Manual Sanitization Instructions

### Option 1: Local CLI (Recommended)

```bash
cd /Users/OG/Projects/metis-portal2

# Scan for non-ASCII in all TypeScript files
find supabase/functions -name "*.ts" -type f -exec grep -l $'[\x80-\xFF]' {} \;

# Fix em-dashes (automated)
find supabase/functions -name "*.ts" -type f -exec sed -i '' 's/—/--/g' {} \;
find supabase/functions -name "*.ts" -type f -exec sed -i '' 's/–/--/g' {} \;

# Fix curly quotes (automated)
find supabase/functions -name "*.ts" -type f -exec sed -i '' "s/'/'/g" {} \;
find supabase/functions -name "*.ts" -type f -exec sed -i '' 's/'/'/g' {} \;
find supabase/functions -name "*.ts" -type f -exec sed -i '' 's/"/"/g' {} \;
find supabase/functions -name "*.ts" -type f -exec sed -i '' 's/"/"/g' {} \;

# Verify no non-ASCII remains
find supabase/functions -name "*.ts" -type f -exec grep -l $'[\x80-\xFF]' {} \;

# Commit if clean
git add supabase/functions
git commit -m "Sanitize non-ASCII: Replace em-dashes and curly quotes in all edge functions (WO-0536)"
```

### Option 2: VS Code (Manual)

1. Open `supabase/functions/work-order-executor/index.ts`
2. Find and Replace (Cmd+Shift+H / Ctrl+Shift+H)
3. Enable regex mode (button: `.*`)
4. Replace patterns:
   - Find: `—|–` → Replace: `--`
   - Find: `'|'` → Replace: `'`
   - Find: `"|"` → Replace: `"`
5. Save and commit

### Option 3: Create Ilmarinen WO (Delegated)

Create a work order for the ilmarinen agent (local CLI access):

```bash
wo create \
  --name "Sanitize non-ASCII in edge functions (WO-0536 completion)" \
  --objective "Run sed commands to replace em-dashes and curly quotes with ASCII equivalents in all supabase/functions/**/*.ts files" \
  --priority p2_medium \
  --tags local-filesystem,git-delivery \
  --ac "1. Run sed to replace em-dashes (— and –) with double-hyphens (--) in all .ts files under supabase/functions/
2. Run sed to replace curly quotes (' ' \" \") with straight quotes (' \") in all .ts files
3. Verify no bytes 0x80-0xFF remain using grep
4. Commit all changes with message: 'Sanitize non-ASCII characters in edge functions (WO-0536)'"
```

## Prevention Verification

To verify the pre-commit hook is active:

```bash
cd /Users/OG/Projects/metis-portal2
git config --get core.hooksPath
# Should output: .github/hooks

# Test with a dummy commit
echo "// Test — em-dash" > /tmp/test.ts
git add /tmp/test.ts
git commit -m "Test"
# Should be blocked with error message
```

## Post-Sanitization Checklist

- [ ] All `.ts` files under `supabase/functions/` contain only ASCII
- [ ] Pre-commit hook is installed: `git config core.hooksPath .github/hooks`
- [ ] Pre-commit hook is executable: `chmod +x .github/hooks/pre-commit`
- [ ] Test commit with non-ASCII is blocked
- [ ] CI/CD pipeline passes after sanitization
- [ ] No file size bloat (files should be smaller after removing multi-byte chars)

## Related Issues

- **WO-0480**: Found tools.ts was 811KB due to UTF-8 corruption (should be 25KB)
- **WO-0534**: UTF-8 corruption guard in github_edit_file
- **CI size guard**: Rejecting large TypeScript files (WO-0535)

## Success Criteria

1. ✅ Pre-commit hook blocks future non-ASCII commits
2. ✅ README documents installation and usage
3. ⏳ One-time sanitization of existing files (requires manual or ilmarinen)
4. ⏳ Commit with message indicating non-ASCII removal
5. ✅ Hook prints filename and line number of violations

**Overall Status**: 3/5 complete (prevention installed, sanitization pending)
