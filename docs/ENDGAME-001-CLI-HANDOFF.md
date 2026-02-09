# ENDGAME-001 — Claude Code CLI Handoff

**Generated: 2026-02-05 ~09:15 UTC | Updated: 2026-02-05 ~19:58 UTC**
**Source: claude.ai orchestration session — verified against live Supabase state**
**Use with: Claude Code CLI or Claude.ai via MCP bridge**

---

## Context for Claude Code

You are resuming build on ENDGAME-001, a unified AI ecosystem. All prior sub-projects (METIS-001, ILMARINEN-001, AGENT-001) are archived and absorbed. The system builds through itself — work orders, harness spans, state_write mutations. Do not bypass the enforcement layer.

---

## Live state — query from Supabase (source of truth)

| Field | Value |
|---|---|
| Supabase project | `phfblljwuvzqzlbzkzpr` |
| GitHub repos | `olivergale/endgame-ilmarinen`, `olivergale/metis-portal2` |
| Portal | https://metis-portal2.vercel.app |
| MCP bridge | `https://mcp.authenticrevolution.com/mcp` (operational) |

**Do not trust static counts or WO lists here. Query live state:**
```bash
./wo list              # Open work orders
./wo list all          # All work orders
./wo get <slug>        # Full details
./wo lessons           # Pending lessons
./wo directives        # Active directives (hard + soft constraints)
```

Project brief, phase, and completion % live in `project_briefs` table (code=ENDGAME-001).

### Phase 3 component inventory (verified)

**3.1 Auto-lessons pipeline — PLUMBING COMPLETE, NEEDS E2E VERIFICATION**

| Component | Type | Status | Notes |
|---|---|---|---|
| `trg_auto_lesson_on_error_span` | trigger on `spans` | ✅ Deployed | Fires on INSERT/UPDATE when status='error' |
| `create_lesson_from_error_span()` | function | ✅ Deployed | Called by trigger, creates lesson row |
| `log_harness_error_as_lesson()` | RPC (2 overloads) | ✅ Deployed | Manual lesson creation |
| `auto_create_lesson()` | RPC | ✅ Deployed | Parametric lesson creation |
| `trg_auto_promote_critical_lesson` | trigger | ✅ Deployed | Immediate promotion for critical severity |
| Lessons in DB | data | ⚠️ 2 rows, both pending | Pipeline fires but hasn't seen enough error volume |

**3.2 Directive promotion loop — PLUMBING COMPLETE, NEVER EXECUTED FULL CYCLE**

| Component | Type | Status | Notes |
|---|---|---|---|
| `lesson-promoter` Edge Function v2 | function | ✅ Active | Tiered: critical=auto, error=batch, warning=review |
| `promote_lesson_to_directive()` | RPC | ✅ Deployed | Creates/updates directive, versions, audit log |
| `trg_auto_promote_critical_lesson` | trigger | ✅ Deployed | Immediate promotion bypass for critical |
| `invoke_lesson_promoter()` | RPC | ✅ Deployed | pg_cron wrapper, calls lesson-promoter/run via pg_net |
| pg_cron job (jobid 1) | cron | ✅ Active | `0 */6 * * *` — every 6 hours |
| `directive_versions` table | table | ✅ Exists | Version history for directive mutations |
| Directive injection in portal-chat | code path | ✅ VERIFIED | portal-chat v34 loads `system_directives WHERE active=true` into system prompt |
| Lessons promoted | data | ❌ 0 | No lesson has hit error severity threshold yet |

**3.3 Self-update via WO — NOT BUILT**

| Component | Type | Status | Notes |
|---|---|---|---|
| Gap detection logic | — | ❌ Missing | Must scan recurring lessons → auto-create draft WO |
| Auto WO creation | — | ❌ Missing | Draft WO with objective derived from lesson pattern |
| Human approval gate | — | ✅ Exists | Enforcement layer already handles this |

### Span latency data (WO-X670IE context)

Last 24h (9 spans with latency data):
- **avg: 18,449ms** | p50: 11,187ms | p95: 56,429ms | max: 60,615ms
- ALL slow spans are `llm-generation` type calling `claude-sonnet-4-20250514`
- Zero tool-call or internal spans are slow
- **Root cause: LLM inference time, not harness overhead**

---

## MCP Bridge — Claude.ai ↔ local execution

The MCP HTTP bridge at `mcp.authenticrevolution.com` is **operational**. Claude.ai connects to it as a remote MCP server to execute work on the local machine.

### Connection details
- **MCP URL:** `https://mcp.authenticrevolution.com/mcp`
- **Auth:** API key via `?api_key=G_co7itauseDR1pwa0gJ3lLRbcoQv337E54nz5SKrlA` (query param) or `X-API-Key` header
- **Protocol:** JSON-RPC 2.0 over POST (MCP Streamable HTTP transport)
- **Working directory:** `/Users/OG/Projects` (all file paths are scoped here)

### Available MCP tools
| Tool | Description |
|---|---|
| `read_file` | Read file contents (path relative to working dir) |
| `write_file` | Write/create files |
| `list_dir` | List directory contents |
| `run_command` | Execute shell commands (60s timeout) |
| `search_files` | Glob-based file search |

### Work order CLI (`wo`)
Claude.ai uses `run_command` to call the `wo` script for Supabase work order operations:

```
./wo list              # Open work orders
./wo list all          # All work orders (including done)
./wo get WO-X670IE-C   # Full details of a work order
./wo create "Name" "Objective" p2_medium  # Create draft WO
./wo transition <uuid> ready     # Approve a WO
./wo transition <uuid> in_progress  # Claim a WO
./wo transition <uuid> done "Summary"  # Complete a WO
./wo lessons           # Pending lessons
./wo directives        # Active system directives
./wo log               # Recent state mutations
```

### Workflow: Claude.ai pushing a work request
1. Claude.ai calls `run_command` → `./wo create "Fix auth bug" "Users getting 401 on..." p1_high`
2. Work order appears in Supabase as `draft` with tag `mcp-created`
3. Human approves (or Claude.ai calls `./wo transition <id> ready`)
4. Claude Code CLI picks it up via `metis` CLI or reads the handoff doc

### Workflow: Claude.ai pulling work
1. Claude.ai calls `run_command` → `./wo list`
2. Sees open work orders with status/priority
3. Calls `./wo get WO-SLUG` for full objective and acceptance criteria
4. Executes work via `run_command`, `read_file`, `write_file`
5. Calls `./wo transition <id> done "Completed: ..."` when finished

### Starting the bridge
From the local machine:
```bash
bash ~/mcp-http-bridge/run.sh
```
Server auto-restarts if it crashes. Health check: `curl https://mcp.authenticrevolution.com/health`

---

## How the system works (build through it, not around it)

### Work order lifecycle
```
draft → ready → in_progress → review → done
                    ↓
                  blocked → in_progress (retry)
```

### Enforcement layer
- `enforce_wo_state_changes` trigger blocks direct SQL updates to WO status columns
- Use `update_work_order_state(wo_id, new_status, ...)` RPC to transition
- `enforce_state_write` trigger blocks direct mutations to `system_manifest`, `decisions`, `schema_changes`
- Use `state_write(op, table, payload, wo_id)` RPC for protected mutations
- `validate_wo_transition()` enforces the state machine
- `wo_enforcer` validates preconditions (name, objective, assigned_to, approval)

### Observability
- `emit_harness_span(trace_id, name, metadata)` → creates span
- `complete_harness_span(span_id, status, output, error)` → closes span
- `start_wo_trace(wo_id)` / `complete_wo_trace(wo_id, status)` → trace lifecycle
- All mutations logged to `state_mutations` with actor and WO reference

### To create and execute a work order
```sql
-- 1. Create
INSERT INTO work_orders (name, slug, objective, acceptance_criteria, priority, assigned_to, requires_approval)
VALUES ('...', 'WO-SLUG', '...', '...', 'p1_high', (SELECT id FROM agents WHERE name = 'ILMARINEN'), true);

-- 2. Approve (if requires_approval)
SELECT update_work_order_state(wo_id, 'ready', p_approved_at := now(), p_approved_by := 'endgame');

-- 3. Claim
SELECT update_work_order_state(wo_id, 'in_progress', p_started_at := now());

-- 4. Execute (build the thing)

-- 5. Register components in manifest via state_write
SELECT state_write('INSERT', 'system_manifest', '{"name":"...", "component_type":"...", "status":"active"}'::jsonb, wo_id);

-- 6. Complete
SELECT update_work_order_state(wo_id, 'done', p_completed_at := now(), p_summary := '...');
```

---

## Execution plan — ordered by priority

### 1. WO-X670IE: Span latency investigation (CLOSE IT)

**Finding:** Latency is LLM inference time (claude-sonnet-4-20250514), not harness overhead. All slow spans are `llm-generation` type. Tool-call and internal spans show normal latency (1-2s).

**Action:**
```sql
-- Get WO ID
SELECT id FROM work_orders WHERE slug = 'WO-X670IE';

-- Approve and claim
SELECT update_work_order_state('<wo_id>', 'ready', p_approved_at := now(), p_approved_by := 'endgame');
SELECT update_work_order_state('<wo_id>', 'in_progress', p_started_at := now());

-- Complete with finding
SELECT update_work_order_state('<wo_id>', 'done', p_completed_at := now(), p_summary := 'Investigation complete. 18.4s avg latency is LLM inference time (claude-sonnet-4-20250514), not harness overhead. All slow spans are llm-generation type. Tool-call spans are 1-2s. Recommendation: add streaming support to portal-chat for perceived responsiveness, and consider a 60s timeout with graceful degradation. No code bug to fix.');
```

**Optional enhancement:** Add a 60s timeout + error handling to the LLM call in portal-chat. Currently the anthropic.messages.create() call has no timeout. If you add one, also wire the timeout error through `log_harness_error_as_lesson()` so the learning pipeline captures it.

---

### 2. Integration test: Error → Lesson → Directive → Portal-chat injection

**Goal:** Prove the full 3.1 + 3.2 learning loop works end to end.

**Step 2a: Trigger an error span to create a lesson automatically**
```sql
-- Insert a test error span that should trigger trg_auto_lesson_on_error_span
INSERT INTO spans (
  span_id, trace_id, name, span_type, status,
  error_message, agent_name, model, metadata, created_at
) VALUES (
  'test-e2e-' || gen_random_uuid()::text,
  'test-trace-e2e-' || now()::text,
  'test-error-for-learning-loop',
  'llm-generation',
  'error',
  'E2E test: Simulated timeout in portal-chat LLM call',
  'METIS',
  'claude-sonnet-4-20250514',
  '{"test": true, "purpose": "e2e learning loop verification"}'::jsonb,
  now()
);
```

**Step 2b: Verify lesson was auto-created**
```sql
SELECT id, pattern, severity, category, reported_by, review_status, applied_to_directives, created_at
FROM lessons
WHERE reported_by = 'auto:error_span'
ORDER BY created_at DESC
LIMIT 3;
```

Expected: A new lesson with pattern containing "Simulated timeout", severity 'error', review_status 'pending', applied_to_directives = false.

**Step 2c: Run the lesson-promoter to promote error-severity lessons**

Either invoke directly:
```bash
curl -X POST https://phfblljwuvzqzlbzkzpr.supabase.co/functions/v1/lesson-promoter/run
```

Or dry-run first:
```bash
curl -X POST "https://phfblljwuvzqzlbzkzpr.supabase.co/functions/v1/lesson-promoter/run?dry_run=true"
```

The lesson-promoter v2 auto-promotes error-severity pending lessons to soft directives.

**Step 2d: Verify directive was created**
```sql
SELECT id, name, content, enforcement, active, created_at
FROM system_directives
WHERE name LIKE 'learned_%'
ORDER BY created_at DESC
LIMIT 3;
```

Expected: A new directive with name like `learned_llm_generation_<uuid_prefix>`, enforcement 'soft', active = true.

**Step 2e: Verify directive appears in portal-chat context**

Send any message to portal-chat and inspect the response's context. The system prompt construction in portal-chat v34 line:
```typescript
supabase.from("system_directives").select("name, content, enforcement").eq("active", true)
```
loads ALL active directives. The new learned directive will appear in `softRulesList` (since enforcement = 'soft').

Alternatively, query directly:
```sql
SELECT name, content, enforcement FROM system_directives WHERE active = true AND name LIKE 'learned_%';
```

**Step 2f: Verify lesson is marked as promoted**
```sql
SELECT id, pattern, applied_to_directives, directive_id, promoted_at, promoted_by
FROM lessons
WHERE applied_to_directives = true
ORDER BY promoted_at DESC
LIMIT 3;
```

**Step 2g: Check directive_versions for audit trail**
```sql
SELECT directive_id, version_number, change_reason, changed_by, created_at
FROM directive_versions
ORDER BY created_at DESC
LIMIT 5;
```

**If any step fails:** The failure itself is useful — log it as a lesson and debug. This is the system testing itself.

---

### 3. Build 3.3: Self-update via work order (THE MAIN DELIVERABLE)

**Objective:** The system detects recurring error patterns or capability gaps from the lessons table and auto-creates a draft work order with objective and acceptance criteria. Human approves → agent executes → gap closed.

**Create a WO for this work:**
```sql
INSERT INTO work_orders (
  name, slug, objective, acceptance_criteria, priority, 
  assigned_to, requires_approval, created_by, source, tags
) VALUES (
  'Build self-update via WO pipeline',
  'WO-SELF-UPDATE',
  'Create a scheduled function that scans lessons for recurring unresolved patterns (≥3 occurrences in same category, or any critical severity unresolved >24h) and auto-creates draft work orders with objective derived from the lesson pattern/rule fields. Human approves, agent executes, gap closed. This is the bridge from Phase 3 to Phase 4.',
  '["Recurring lesson patterns (≥3 same category) auto-generate draft WOs", "Critical unresolved lessons >24h auto-generate p1 draft WOs", "Auto-created WOs include: name, objective (from lesson pattern+rule), acceptance_criteria (from lesson resolution field), priority (from severity mapping), tags [auto-created, self-update]", "Duplicate detection: does not create WO if an open WO already targets the same lesson category", "Registered in system_manifest via state_write", "E2E test: insert 3 lessons with same category → verify draft WO appears"]',
  'p1_high',
  (SELECT id FROM agents WHERE name = 'ILMARINEN'),
  true,
  'cto',
  'cli',
  ARRAY['phase-3', 'self-update', 'learning-loop']
);
```

Then approve, claim, and build.

**Implementation approach:**

The cleanest path is extending `lesson-promoter` v2 to add a `/self-update` endpoint (or adding logic to the existing `/run` batch), plus a new RPC function. Here's the design:

**New RPC: `detect_lesson_gaps()`**
```sql
CREATE OR REPLACE FUNCTION detect_lesson_gaps()
RETURNS TABLE (
  category TEXT,
  lesson_count BIGINT,
  severities TEXT[],
  sample_pattern TEXT,
  sample_rule TEXT,
  has_open_wo BOOLEAN
) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  WITH category_stats AS (
    SELECT
      l.category,
      count(*) as cnt,
      array_agg(DISTINCT l.severity) as sevs,
      (array_agg(l.pattern ORDER BY l.created_at DESC))[1] as latest_pattern,
      (array_agg(l.rule ORDER BY l.created_at DESC))[1] as latest_rule
    FROM lessons l
    WHERE l.review_status = 'pending'
      AND l.applied_to_directives = false
    GROUP BY l.category
    HAVING count(*) >= 3
       OR bool_or(l.severity = 'critical' AND l.created_at < now() - interval '24 hours')
  ),
  open_wo_categories AS (
    SELECT DISTINCT unnest(tags) as tag
    FROM work_orders
    WHERE status NOT IN ('done', 'cancelled')
      AND 'self-update' = ANY(tags)
  )
  SELECT
    cs.category,
    cs.cnt,
    cs.sevs,
    cs.latest_pattern,
    cs.latest_rule,
    EXISTS (
      SELECT 1 FROM open_wo_categories owc
      WHERE owc.tag = 'cat:' || cs.category
    ) as has_open_wo
  FROM category_stats cs;
END;
$$;
```

**New RPC: `auto_create_gap_wo(p_category TEXT, p_pattern TEXT, p_rule TEXT, p_severity TEXT)`**
```sql
CREATE OR REPLACE FUNCTION auto_create_gap_wo(
  p_category TEXT,
  p_pattern TEXT,
  p_rule TEXT,
  p_severity TEXT DEFAULT 'warning'
) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE
  v_wo_id UUID;
  v_slug TEXT;
  v_priority TEXT;
  v_ilmarinen_id UUID;
BEGIN
  -- Map severity to priority
  v_priority := CASE p_severity
    WHEN 'critical' THEN 'p1_high'
    WHEN 'error' THEN 'p1_high'
    WHEN 'warning' THEN 'p2_medium'
    ELSE 'p3_low'
  END;

  v_slug := 'WO-AUTO-' || upper(substring(md5(p_category || now()::text) from 1 for 6));

  SELECT id INTO v_ilmarinen_id FROM agents WHERE name = 'ILMARINEN' LIMIT 1;

  INSERT INTO work_orders (
    name, slug, objective, acceptance_criteria, priority,
    assigned_to, requires_approval, created_by, source, tags
  ) VALUES (
    'Auto: Resolve recurring ' || p_category || ' issues',
    v_slug,
    'Recurring lesson pattern detected in category "' || p_category || '": ' || COALESCE(p_pattern, 'unknown pattern') || '. Rule: ' || COALESCE(p_rule, 'investigate and resolve'),
    '["Root cause identified for ' || p_category || ' lessons", "Fix deployed and verified", "No new lessons in this category for 24h after fix"]',
    v_priority,
    v_ilmarinen_id,
    true,
    'self-update-system',
    'cli',
    ARRAY['auto-created', 'self-update', 'cat:' || p_category]
  ) RETURNING id INTO v_wo_id;

  -- Audit
  INSERT INTO audit_log (event_type, actor_type, actor_id, target_type, target_id, action, payload)
  VALUES (
    'auto_wo_created', 'system', 'self-update-pipeline', 'work_order', v_wo_id, 'create',
    jsonb_build_object('category', p_category, 'pattern', p_pattern, 'severity', p_severity, 'slug', v_slug)
  );

  RETURN v_wo_id;
END;
$$;
```

**Add to lesson-promoter v3: self-update logic in the `/run` batch**

After the existing Tier 1/2/3 processing, add:

```typescript
// Tier 4: Self-update — detect recurring gaps and auto-create draft WOs
const { data: gaps } = await supabase.rpc('detect_lesson_gaps');

for (const gap of (gaps || [])) {
  if (gap.has_open_wo) {
    results.push({
      tier: 'self_update', category: gap.category,
      action: 'skipped_existing_wo', lesson_count: gap.lesson_count
    });
    continue;
  }

  if (dryRun) {
    results.push({
      tier: 'self_update', category: gap.category,
      action: 'would_create_wo', lesson_count: gap.lesson_count,
      sample_pattern: gap.sample_pattern, dry_run: true
    });
    continue;
  }

  const { data: woId, error: woErr } = await supabase.rpc('auto_create_gap_wo', {
    p_category: gap.category,
    p_pattern: gap.sample_pattern,
    p_rule: gap.sample_rule,
    p_severity: gap.severities?.[0] || 'warning'
  });

  results.push({
    tier: 'self_update', category: gap.category,
    action: woErr ? 'failed' : 'wo_created',
    work_order_id: woId, error: woErr?.message,
    lesson_count: gap.lesson_count
  });
}
```

**Register components via state_write after building:**
```sql
SELECT state_write('INSERT', 'system_manifest', '{"name":"detect_lesson_gaps", "component_type":"rpc_function", "status":"active", "description":"Scans lessons for recurring unresolved patterns that warrant a work order"}'::jsonb, '<wo_id>');
SELECT state_write('INSERT', 'system_manifest', '{"name":"auto_create_gap_wo", "component_type":"rpc_function", "status":"active", "description":"Auto-creates draft WO from detected lesson gap"}'::jsonb, '<wo_id>');
SELECT state_write('INSERT', 'system_manifest', '{"name":"lesson-promoter-v3-self-update", "component_type":"edge_function_upgrade", "status":"active", "description":"Added Tier 4 self-update gap detection to lesson-promoter batch"}'::jsonb, '<wo_id>');
```

**E2E test for self-update:**
```sql
-- Insert 3 lessons with same category to trigger the threshold
INSERT INTO lessons (id, occurred_at, pattern, context, rule, severity, category, reported_by, review_status, created_at, updated_at)
VALUES
  (gen_random_uuid(), now(), 'Test gap: repeated auth failure', 'User login flow', 'Add retry logic with exponential backoff', 'warning', 'auth_failure_test', 'e2e_test', 'pending', now(), now()),
  (gen_random_uuid(), now(), 'Test gap: repeated auth failure variant 2', 'API auth flow', 'Add retry logic with exponential backoff', 'warning', 'auth_failure_test', 'e2e_test', 'pending', now(), now()),
  (gen_random_uuid(), now(), 'Test gap: repeated auth failure variant 3', 'Session refresh', 'Add retry logic with exponential backoff', 'warning', 'auth_failure_test', 'e2e_test', 'pending', now(), now());

-- Run lesson-promoter (or call detect_lesson_gaps directly)
SELECT * FROM detect_lesson_gaps();
-- Expected: row with category='auth_failure_test', lesson_count=3, has_open_wo=false

-- Invoke the self-update
-- curl -X POST https://phfblljwuvzqzlbzkzpr.supabase.co/functions/v1/lesson-promoter/run

-- Verify WO was created
SELECT slug, name, status, priority, tags
FROM work_orders
WHERE 'self-update' = ANY(tags)
ORDER BY created_at DESC LIMIT 5;

-- Clean up test data after verification
DELETE FROM lessons WHERE reported_by = 'e2e_test' AND category = 'auth_failure_test';
DELETE FROM work_orders WHERE tags @> ARRAY['self-update'] AND name LIKE '%auth_failure_test%';
```

---

### 4. After Phase 3 deliverables verified → update project brief

```sql
UPDATE project_briefs
SET
  completion_pct = 75,
  current_phase = 3,
  phases = jsonb_set(
    phases,
    '{2,status}',
    '"complete"'::jsonb
  ),
  updated_at = now()
WHERE code = 'ENDGAME-001';
```

Note: Only bump to Phase 4 after all three deliverables are verified working. Phase 3 at 75% means the learning loop is closed. Phase 4 (Autonomy) is the next frontier: cron triggers, auto-routing, agent workspace.

---

### 5. WO-UD2H8F: Health check dashboard (if time permits)

Lower priority. Skip unless the above are all done. The `/summary` command in portal-chat already provides most of this data — a dedicated dashboard would add a UI but not new capability.

---

## Known issues

- ~~MCP bridge at `mcp.authenticrevolution.com` requires the Python FastAPI server running locally with Cloudflare tunnel~~ **FIXED** — `run.sh` now auto-restarts server, handles SIGHUP, validates health on startup. Start with `bash ~/mcp-http-bridge/run.sh`
- Supabase anon key was regenerated; ensure CLAUDE.md in repos has current key
- Max compaction per block errors in claude.ai — use Claude Code CLI for heavy execution, claude.ai for orchestration only
- `lesson-promoter` has `verify_jwt: false` — fine for now since cron calls it without auth, but should be hardened before Phase 4
- `wo` script at `/Users/OG/Projects/wo` has Supabase anon key embedded — acceptable for local use, do not commit to public repos

## Key source references

- `portal-chat` v34: Loads directives via `system_directives WHERE active=true` into system prompt (verified in source). Directives split into `hardConstraints` and `softRules`.
- `lesson-promoter` v2: Tier 1 error→auto-promote, Tier 2 warning→flag, Tier 3 cluster detection. Cron calls `/run` endpoint.
- `promote_lesson_to_directive()` RPC: Creates or versions directive, marks lesson as promoted, writes audit_log.
- `invoke_lesson_promoter()` RPC: pg_cron wrapper using pg_net to POST to lesson-promoter/run.
- `create_lesson_from_error_span()`: Trigger function on spans table, creates lesson row from error span data.

## Lessons table schema (for reference)

```
id, occurred_at, pattern, context, rule, example_bad, example_good,
severity, category, thread_id, work_order_id, trace_id, reported_by,
applied_to_directives, directive_id, promoted_at, promoted_by,
reviewed, reviewed_at, reviewed_by, review_notes, review_status,
created_at, updated_at
```

## System directives table schema (for reference)

```
id, project_id, scope, thread_id, directive_type, name, content,
enforcement, violation_message, priority, active,
created_at, updated_at, created_by, enforcement_mode, check_key
```
