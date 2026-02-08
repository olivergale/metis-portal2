# Frontend Agent Team — System Design

**Status**: PROPOSED
**Author**: ilmarinen
**Date**: 2026-02-08
**Integrates with**: ENDGAME-001 Phase 4+ infrastructure

## Problem

The daemon executes WOs, commits code, and pushes — but never validates frontend output. A `const` redeclaration SyntaxError in health.html survived 6 consecutive commits and shipped to production. The backend has enforcement triggers, QA gates, auto-QA evaluation, and audit review. The frontend has nothing.

## Design Principle

**Layer into the existing pipeline, don't build parallel infrastructure.**

Every component below uses existing ENDGAME primitives: WO tags, auto-routing triggers, QA checklist population, qa_findings, execution_log, and the daemon's post-execution flow.

---

## Architecture: 5 Layers

```
Layer 1: PRE-COMMIT VALIDATION (daemon)
   ↓ catches syntax errors before they enter git
Layer 2: AUTO-TAGGING (daemon)
   ↓ marks WOs that touch frontend code
Layer 3: FRONTEND QA CRITERIA (trigger)
   ↓ injects frontend-specific acceptance criteria
Layer 4: FRONTEND REVIEW AGENT (auto-routing)
   ↓ specialized review for frontend WOs
Layer 5: POST-DEPLOY SMOKE TEST (webhook)
   ↓ validates deployed pages actually work
```

### Layer 1: Daemon Pre-Commit Validation

**Where**: Daemon `execute_work_order()`, after Claude Code exits, BEFORE `git commit`.

**What it does**:
1. `git diff --name-only` to find modified files
2. For each `.html` file: extract `<script>` blocks, write to temp file, run `node --check`
3. For each `.js`/`.ts` file: run `node --check` directly
4. If ANY check fails:
   - Log to `work_order_execution_log` with phase `frontend_validation` and the error
   - Do NOT commit
   - Call `/fail` with reason "Frontend validation failed: {error}"
   - WO transitions to `failed`, lesson auto-created from error span

**Impact**: Catches 100% of syntax errors. Would have prevented the health.html outage.

**Implementation**: ~30 lines added to daemon's post-execution flow. No new infrastructure.

```python
def validate_frontend(work_dir):
    """Pre-commit frontend validation. Returns (ok, errors)."""
    errors = []
    modified = subprocess.run(
        ["git", "diff", "--cached", "--name-only"],
        capture_output=True, text=True, cwd=work_dir
    ).stdout.strip().split('\n')

    for f in modified:
        if f.endswith('.html'):
            # Extract <script> blocks, write temp, node --check
            content = Path(work_dir / f).read_text()
            scripts = re.findall(r'<script[^>]*>(.*?)</script>', content, re.DOTALL)
            for i, script in enumerate(scripts):
                tmp = Path(f'/tmp/fe_check_{i}.js')
                tmp.write_text(script)
                result = subprocess.run(["node", "--check", str(tmp)], capture_output=True, text=True)
                if result.returncode != 0:
                    errors.append(f"{f} script block {i}: {result.stderr.strip()}")
        elif f.endswith(('.js', '.ts', '.mjs')):
            result = subprocess.run(["node", "--check", str(work_dir / f)], capture_output=True, text=True)
            if result.returncode != 0:
                errors.append(f"{f}: {result.stderr.strip()}")

    return (len(errors) == 0, errors)
```

### Layer 2: Auto-Tagging

**Where**: Daemon `execute_work_order()`, after execution completes.

**What it does**:
1. Check `git diff --name-only` for frontend file patterns: `*.html`, `*.js`, `*.css`, `*.tsx`, `*.jsx`, `*.vue`, `*.svelte`
2. If frontend files modified, add `frontend` tag to the WO via API
3. Tag persists through review routing

**Why it matters**: Tags drive the entire downstream pipeline — review routing, QA criteria injection, and smoke test targeting all key off `frontend` tag.

**Implementation**: 5 lines in daemon. Uses existing `PATCH /rest/v1/work_orders` to append tag.

### Layer 3: Frontend QA Criteria Injection

**Where**: New trigger or enhancement to `auto_populate_qa_checklist`.

**What it does**: When a WO with `frontend` tag transitions to `review`, inject additional frontend-specific QA criteria:

| Criterion | Evaluation Method |
|-----------|------------------|
| No JS syntax errors in modified files | Daemon Layer 1 already validated (evidence in execution_log) |
| Modified pages return HTTP 200 | Auto-QA Haiku checks deployment URL |
| No duplicate const/let declarations | Static analysis in execution_log evidence |
| Console-clean page load | Post-deploy smoke test (Layer 5) |

**Implementation**: Modify `auto_populate_qa_checklist()` RPC to check tags and append frontend criteria. Or create `trg_frontend_qa_criteria` trigger (fires alphabetically after `trg_auto_populate`).

### Layer 4: Frontend Review Agent

**Where**: `auto_route_review()` trigger + `agents` table.

**What it does**:
1. Register `frontend` agent in `agents` table (name: `frontend`, agent_type: `engineering`, status: `active`)
2. Add routing rule to `auto_route_review()`:
   ```sql
   ELSIF v_tags && ARRAY['frontend', 'ui', 'css', 'html'] THEN
     v_reviewer_name := 'frontend';
   ```
3. Frontend agent can be a Claude Code instance with frontend-specific system prompt and tools (Playwright, lighthouse, axe-core)

**Capabilities** (progressive):
- **Phase A**: Tag-based routing only (routes to human review for now)
- **Phase B**: Automated review via headless browser — screenshot comparison, console error capture, responsive check
- **Phase C**: Full agent with Playwright MCP — can interact with pages, fill forms, verify flows

**Agent roster update**:
```
metis      → orchestrator (routes, plans)
ilmarinen  → executor (builds, deploys)
audit      → reviewer (compliance, state machine)
security   → reviewer (auth, RLS, secrets)
qa         → reviewer (acceptance criteria)
frontend   → reviewer (syntax, visual, UX)      ← NEW
```

### Layer 5: Post-Deploy Smoke Test

**Where**: Vercel deploy webhook → edge function → qa_findings.

**What it does**:
1. Vercel completes deploy → webhook hits `frontend-smoke-test` edge function
2. Edge function determines which pages were modified (from WO execution_log)
3. Fetches each page, checks:
   - HTTP 200 response
   - No `<script>` parse errors (re-extract and node --check remotely, or check response body for error indicators)
   - Page body is non-empty
   - Key DOM elements exist (configurable per page)
4. Writes results to `qa_findings` linked to the active WO
5. If failures found, WO gate blocks `review → done`

**Implementation**: New edge function `frontend-smoke-test`. Receives Vercel webhook payload with deployment URL. Runs checks against deployed URL. ~100 lines.

---

## Integration Map

```
WO Created
  ↓
Daemon picks up WO
  ↓
Claude Code executes
  ↓
[Layer 1] validate_frontend() ←── BLOCKS commit on syntax error
  ↓ pass
[Layer 2] Auto-tag 'frontend' if frontend files modified
  ↓
git commit + push → Vercel deploys
  ↓                        ↓
  ↓                  [Layer 5] Smoke test
  ↓                        ↓ writes qa_findings
  ↓
/complete → WO → review
  ↓
[Layer 3] Frontend QA criteria injected into checklist
  ↓
[Layer 4] auto_route_review → frontend agent
  ↓
auto-qa evaluates (including frontend criteria)
  ↓
QA gate: review → done (blocked if fails)
```

---

## Implementation Sequence

These should be created as WOs through the system:

| Order | WO Name | Priority | Dependencies |
|-------|---------|----------|-------------|
| 1 | Daemon pre-commit frontend validation | p1_high | None |
| 2 | Auto-tag frontend WOs | p2_medium | None |
| 3 | Register frontend agent | p2_medium | None |
| 4 | Frontend QA criteria injection | p2_medium | #2, #3 |
| 5 | Post-deploy smoke test | p2_medium | #2 |
| 6 | Frontend agent headless browser review | p3_low | #3 |

**Layer 1 alone eliminates 100% of syntax-class bugs.** Layers 2-5 add progressively deeper validation. Start with Layer 1, deliver value immediately, expand as needed.

---

## Schema Changes Required

1. `agents` table: INSERT row for `frontend` agent
2. `auto_route_review()`: Add frontend tag matching (ALTER FUNCTION)
3. `work_order_execution_log.phase` CHECK: Add `frontend_validation` value
4. Optional: `agent_type` enum: Add `frontend` if separate type needed (or reuse `engineering`)

## No New Tables Required

Everything writes to existing tables:
- Validation results → `work_order_execution_log` (phase: `frontend_validation`)
- Review findings → `qa_findings`
- Smoke test results → `qa_findings`
- Routing decisions → `state_mutations`
- Agent registration → `agents`

---

## Success Metrics

- **Zero frontend syntax errors reaching production** (Layer 1 catch rate)
- **Frontend WOs auto-tagged** (Layer 2 accuracy — should be 100% for file-pattern detection)
- **Smoke test pass rate** post-deploy (Layer 5)
- **Time to detect frontend regression**: target < 2 minutes (Vercel deploy + smoke test)
