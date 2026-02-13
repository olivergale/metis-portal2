import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.30.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const VALID_CATEGORIES = [
  'state_consistency','acceptance_criteria','acceptance_criterion','anomaly',
  'security','completeness','execution_log','execution_trail',
  'completion_summary','qa_checklist','qa_checklist_item'
] as const;

const VALID_FINDING_TYPES = ['pass', 'fail', 'warning', 'info', 'na'] as const;

interface QAFinding {
  finding_type: string; category: string; description: string;
  evidence: any; checklist_item_id?: string; error_code?: string;
}

function initClients() {
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')! });
  return { supabase, anthropic };
}

async function insertFindings(supabase: any, findings: QAFinding[], woId: string, agentId: string) {
  const inserted: any[] = [], errors: any[] = [];
  for (const f of findings) {
    const cat = f.category || 'anomaly';
    if (!VALID_CATEGORIES.includes(cat as any)) { errors.push({ finding: f, error: `Invalid category: ${cat}` }); continue; }
    const ft = VALID_FINDING_TYPES.includes(f.finding_type as any) ? f.finding_type : 'warning';
    const { data, error } = await supabase.from('qa_findings').insert({
      work_order_id: woId, finding_type: ft, category: cat,
      description: f.description, evidence: f.evidence || {},
      agent_id: agentId, checklist_item_id: f.checklist_item_id, error_code: f.error_code
    }).select().single();
    if (error) errors.push({ finding: f, error: error.message });
    else if (data) {
      inserted.push(data);
      await supabase.from('audit_log').insert({
        event_type: 'qa_finding_created', actor_type: 'agent', actor_id: agentId,
        target_type: 'qa_finding', target_id: data.id, action: 'create',
        payload: f, work_order_id: woId
      });
    }
  }
  return { inserted, errors };
}

// --- GitHub file verification functions ---

function extractFilePathsFromACs(acText: string, objective: string): string[] {
  const combined = `${acText}\n${objective || ''}`;
  // Match paths containing a slash and ending in .ts, .tsx, .js, or .sql
  const pathRegex = /(?:^|[\s"'`(,])([a-zA-Z0-9_\-./]+\/[a-zA-Z0-9_\-./]*\.(?:ts|tsx|js|sql))(?:[\s"'`),]|$)/gm;
  const paths: string[] = [];
  let match;
  while ((match = pathRegex.exec(combined)) !== null) {
    const p = match[1].trim();
    if (p && !paths.includes(p)) paths.push(p);
  }
  return paths;
}

interface GitHubFileEvidence {
  path: string;
  exists: boolean;
  size: number;
  content_snippet: string;
  error?: string;
  matched_patterns?: string[];
  unmatched_patterns?: string[];
}

async function fetchGitHubFileEvidence(paths: string[], supabase: any): Promise<GitHubFileEvidence[]> {
  const results: GitHubFileEvidence[] = [];

  // Try to get GITHUB_TOKEN from vault secrets, then fall back to env var
  let token: string | null = null;
  try {
    const { data: secretRow } = await supabase
      .from('vault.decrypted_secrets' as any)
      .select('decrypted_secret')
      .eq('name', 'GITHUB_TOKEN')
      .single();
    if (secretRow?.decrypted_secret) token = secretRow.decrypted_secret;
  } catch (_e) {
    // vault query failed, try env
  }
  if (!token) token = Deno.env.get('GITHUB_TOKEN') || null;

  if (!token) {
    return paths.slice(0, 3).map(p => ({
      path: p, exists: false, size: 0, content_snippet: '',
      error: 'GITHUB_TOKEN not found in vault secrets or environment variables'
    }));
  }

  for (const p of paths.slice(0, 3)) {
    try {
      const resp = await fetch(
        `https://api.github.com/repos/olivergale/metis-portal2/contents/${p}?ref=main`,
        { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'qa-review-lie-detector' } }
      );
      if (!resp.ok) {
        results.push({ path: p, exists: false, size: 0, content_snippet: '', error: `GitHub API ${resp.status}: ${resp.statusText}` });
        continue;
      }
      const data = await resp.json();
      if (data.type !== 'file' || !data.content) {
        results.push({ path: p, exists: false, size: data.size || 0, content_snippet: '', error: 'Not a file or no content returned' });
        continue;
      }
      // Decode base64 content
      const decoded = atob(data.content.replace(/\n/g, ''));
      results.push({
        path: p,
        exists: true,
        size: data.size || decoded.length,
        content_snippet: decoded.slice(0, 500),
      });
    } catch (e: any) {
      results.push({ path: p, exists: false, size: 0, content_snippet: '', error: `Fetch error: ${e.message}` });
    }
  }
  return results;
}

function checkCodePatternsInFile(fileContent: string, acText: string): { matched_patterns: string[]; unmatched_patterns: string[] } {
  // Extract identifiers: words_with_underscores (snake_case function/variable names)
  const identifierRegex = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;
  const identifiers = new Set<string>();
  let m;
  while ((m = identifierRegex.exec(acText)) !== null) {
    const id = m[1];
    // Filter out common SQL/English phrases
    if (!['the_same', 'work_order', 'work_orders', 'edge_function', 'each_path',
      'max_iterations', 'created_at', 'updated_at', 'content_type', 'status_code',
      'error_code', 'finding_type', 'first_500'].includes(id)) {
      identifiers.add(id);
    }
  }

  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const id of identifiers) {
    if (fileContent.includes(id)) matched.push(id);
    else unmatched.push(id);
  }
  return { matched_patterns: matched, unmatched_patterns: unmatched };
}

// --- End GitHub file verification functions ---

interface SystemStateEvidence {
  text: string;
  github_file_evidence: GitHubFileEvidence[];
}

async function gatherSystemStateEvidence(supabase: any, acText: string, summary: string, objective?: string): Promise<SystemStateEvidence> {
  const combined = `${acText}\n${summary || ''}`;
  const evidence: string[] = [];

  try {
    // Extract potential entity names from ACs and summary
    // Functions/triggers: must contain underscore (PG functions are snake_case)
    const funcNames = [...new Set(
      (combined.match(/\b([a-z][a-z0-9_]{2,50})\s*\(/g) || []).map(m => m.replace(/\s*\($/, ''))
        .filter(n => n.includes('_')) // Must have underscore ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ filters "fail(", "has(", "set(" etc
        .filter(n => !['select_', 'insert_', 'update_', 'delete_', 'create_', 'drop_', 'order_by',
          'group_by', 'is_not', 'is_null', 'not_null', 'left_join', 'inner_join', 'cross_join',
          'string_agg', 'json_build', 'jsonb_build', 'array_agg', 'row_number', 'old_string',
          'new_string'].some(prefix => n.startsWith(prefix) || n === prefix))
    )];

    // Table names: common patterns like "X table", "from X", "into X"
    const tablePatterns = combined.match(/(?:table|from|into|on)\s+([a-z_]{3,40})/gi) || [];
    const tableNames = [...new Set(
      tablePatterns.map(m => m.replace(/^(?:table|from|into|on)\s+/i, '').toLowerCase())
        .filter(n => !['the', 'this', 'that', 'each', 'all', 'any', 'work'].includes(n))
    )];

    // Migration names: snake_case patterns near "migration"
    const migrationPatterns = combined.match(/migration[:\s]+([a-z_]{5,80})/gi) || [];
    const migNames = migrationPatterns.map(m => m.replace(/^migration[:\s]+/i, ''));

    // Check functions exist in pg_proc
    if (funcNames.length > 0) {
      const funcList = funcNames.slice(0, 10);
      const { data: funcs } = await supabase.rpc('run_sql', {
        sql_query: `SELECT proname FROM pg_proc WHERE proname IN (${funcList.map(f => `'${f}'`).join(',')})`,
      });
      const foundFuncs = (funcs || []).map((r: any) => r.proname);
      for (const f of funcList) {
        evidence.push(`Function ${f}: ${foundFuncs.includes(f) ? 'EXISTS in pg_proc' : 'NOT FOUND'}`);
      }
    }

    // Check triggers on work_orders and qa_findings
    if (funcNames.length > 0 || tableNames.length > 0) {
      const { data: triggers } = await supabase.rpc('run_sql', {
        sql_query: `SELECT t.tgname, c.relname as table_name, p.proname as func_name
                    FROM pg_trigger t
                    JOIN pg_class c ON t.tgrelid = c.oid
                    JOIN pg_proc p ON t.tgfoid = p.oid
                    WHERE NOT t.tgisinternal
                    AND (c.relname IN ('work_orders','qa_findings','work_order_execution_log')
                         OR p.proname IN (${funcNames.slice(0, 10).map(f => `'${f}'`).join(',') || "'__none__'"}))
                    ORDER BY t.tgname`,
      });
      if (triggers?.length > 0) {
        evidence.push(`Active triggers found: ${triggers.map((t: any) => `${t.tgname} on ${t.table_name} -> ${t.func_name}`).join('; ')}`);
      }
    }

    // Check tables/columns exist
    if (tableNames.length > 0) {
      const tblList = tableNames.slice(0, 5);
      const { data: cols } = await supabase.rpc('run_sql', {
        sql_query: `SELECT table_name, column_name FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name IN (${tblList.map(t => `'${t}'`).join(',')})
                    ORDER BY table_name, ordinal_position`,
      });
      if (cols?.length > 0) {
        const byTable: Record<string, string[]> = {};
        for (const c of cols) {
          if (!byTable[c.table_name]) byTable[c.table_name] = [];
          byTable[c.table_name].push(c.column_name);
        }
        for (const [tbl, columns] of Object.entries(byTable)) {
          evidence.push(`Table ${tbl}: EXISTS (columns: ${columns.slice(0, 10).join(', ')}${columns.length > 10 ? '...' : ''})`);
        }
        for (const t of tblList) {
          if (!byTable[t]) evidence.push(`Table ${t}: NOT FOUND`);
        }
      }
    }

    // Check recent migrations
    if (migNames.length > 0) {
      const { data: migs } = await supabase.rpc('run_sql', {
        sql_query: `SELECT name FROM supabase_migrations.schema_migrations WHERE name LIKE '%${migNames[0]}%' LIMIT 5`,
      });
      if (migs?.length > 0) {
        evidence.push(`Migrations matching: ${migs.map((m: any) => m.name).join(', ')}`);
      }
    }
  } catch (e: any) {
    evidence.push(`E2E evidence gathering error: ${e.message}`);
  }

  // GitHub file verification (AC#4)
  let githubEvidence: GitHubFileEvidence[] = [];
  try {
    const filePaths = extractFilePathsFromACs(acText, objective || '');
    if (filePaths.length > 0) {
      githubEvidence = await fetchGitHubFileEvidence(filePaths, supabase);
      // Run pattern matching on files that were fetched successfully
      for (const gf of githubEvidence) {
        if (gf.exists && gf.content_snippet) {
          const patterns = checkCodePatternsInFile(gf.content_snippet, acText);
          gf.matched_patterns = patterns.matched_patterns;
          gf.unmatched_patterns = patterns.unmatched_patterns;
        }
      }
    }
  } catch (e: any) {
    githubEvidence = [{ path: 'N/A', exists: false, size: 0, content_snippet: '', error: `GitHub evidence error: ${e.message}` }];
  }

  return {
    text: evidence.length > 0 ? evidence.join('\n') : 'No system state evidence gathered',
    github_file_evidence: githubEvidence,
  };
}

function buildLieDetectorPrompt(wo: any, execLog: any[], acList: string, systemStateEvidence?: string, githubFileEvidence?: GitHubFileEvidence[], mutationVerification?: any) {
  const logSummary = (execLog || []).map((e: any) => {
    const d = e.detail || {};
    const toolInfo = d.tool_name ? ` [tool:${d.tool_name}]` : d.tool_names ? ` [tools:${d.tool_names.join(',')}]` : '';
    const success = d.success !== undefined ? ` success=${d.success}` : '';
    const content = d.content ? ` content=${String(d.content).slice(0, 200)}` : '';
    return `${e.phase}${toolInfo}${success}${content}`;
  }).join('\n');

  return `You are a FORENSIC QA AUDITOR. Your job is to detect FABRICATION and UNSUPPORTED CLAIMS in work order completion summaries.

## WORK ORDER
Slug: ${wo.slug}
Objective: ${wo.objective}
Acceptance Criteria:
${acList}
Summary: ${wo.summary || 'NO SUMMARY PROVIDED'}
Status: ${wo.status}

## EXECUTION LOG (process evidence - ${(execLog || []).length} entries)
${logSummary || 'NO EXECUTION LOG ENTRIES'}

## SYSTEM STATE EVIDENCE (outcome evidence - live DB verification)
${systemStateEvidence || 'No system state evidence available'}

## GITHUB FILE EVIDENCE (code verification - live GitHub main branch check)
${(() => {
    if (!githubFileEvidence || githubFileEvidence.length === 0) return 'No GitHub file paths detected in acceptance criteria.';
    return githubFileEvidence.map(gf => {
      if (gf.error) return `File: ${gf.path} - ERROR: ${gf.error}`;
      if (!gf.exists) return `File: ${gf.path} - NOT FOUND on main branch`;
      const patterns = [];
      if (gf.matched_patterns && gf.matched_patterns.length > 0) patterns.push(`Matched patterns: ${gf.matched_patterns.join(', ')}`);
      if (gf.unmatched_patterns && gf.unmatched_patterns.length > 0) patterns.push(`Unmatched patterns: ${gf.unmatched_patterns.join(', ')}`);
      return `File: ${gf.path} - EXISTS (${gf.size} bytes)${patterns.length > 0 ? '\\n  ' + patterns.join('\\n  ') : ''}\\n  Snippet: ${gf.content_snippet?.slice(0, 200) || 'N/A'}`;
    }).join('\\n');
  })()}

## YOUR TASK: FORENSIC VERIFICATION
For EACH claim in the summary, cross-reference against the execution log AND system state evidence. Apply these checks:

### CHECK 1: Claims vs Evidence (Execution Log OR System State)
Every factual claim in the summary (file created, query run, migration applied, function deployed) MUST have EITHER a matching execution_log entry OR matching system state evidence (function EXISTS, trigger EXISTS, table EXISTS, migration found). If a claim has NEITHER, it is FABRICATED.

### CHECK 2: Mutation Claims vs Actual Mutations
If the summary says "created table X", "applied migration Y", "inserted Z rows" ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ there MUST be EITHER a matching tool call in the execution log OR the entity must exist in system state evidence. Example: claim "created function foo()" is SUPPORTED if system state shows "Function foo: EXISTS in pg_proc", even without an execution_log entry.

### CHECK 3: "Deployed" / "Verified" Statements
If the summary says "deployed function X" or "verified endpoint Y" ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ there MUST be a deploy_edge_function call or a verification query in the log. Unsubstantiated deploy/verify claims = FABRICATED.

### CHECK 4: Scope Drift Outside ACs
Compare work done (per execution log) against acceptance criteria. Flag any claims about work NOT in the acceptance criteria. Also flag ACs that were NOT addressed.

### CHECK 5: Inflated or Vague Claims
Flag summaries that use vague language ("set up", "handled", "implemented properly") without specific evidence. Flag claims of completeness ("all ACs met") when log evidence is thin.

### CHECK 6: Functional Equivalence
If the implementation achieves the SAME FUNCTIONAL OUTCOME via a different approach than specified in the AC, mark as PASS with a note explaining the functional equivalence. Only mark as FAIL if the functional requirement itself is unmet. Examples of functional equivalence:
- Different WHERE clause achieving the same filter (e.g., "status != 'done'" vs "status IN ('draft','pending','failed')")
- Different category names covering the same semantic domain (e.g., "execution_log" vs "execution_trail")
- Different registration mechanism achieving the same result (e.g., direct INSERT vs RPC call vs trigger)
- Different column names with same purpose (e.g., "name" vs "title")
If outcome is functionally equivalent, finding_type = "pass" with evidence noting the alternative approach.

## OUTPUT FORMAT
Return a JSON array of findings. Each finding:
{
  "finding_type": "fail" | "warning" | "info" | "pass",
  "category": one of [${VALID_CATEGORIES.join(', ')}],
  "description": "specific description",
  "evidence": { "claim": "what was claimed", "log_support": "matching log entry or NONE", "verdict": "supported|unsupported|partial" }
}

CRITICAL RULES:
- Unsupported claims (no log evidence AND no system state evidence) -> finding_type = "fail", NOT warning
- Claims with system state evidence but no execution log -> finding_type = "pass" (outcome verified)
- Partial evidence (vague match in either source) -> finding_type = "warning"
- Scope drift -> finding_type = "warning", category = "acceptance_criteria"
- Missing AC coverage -> finding_type = "fail", category = "acceptance_criteria"
- If summary is empty/null -> finding_type = "fail", category = "completion_summary"
- If execution log is empty AND system state has no matching evidence -> finding_type = "fail", category = "execution_trail"
- If execution log is empty BUT system state confirms outcomes -> finding_type = "pass" (CLI work with verifiable results)
- Functional equivalence (CHECK 6) -> finding_type = "pass" with note explaining alternative approach
- Evidence says "Verified" but textual diff exists -> finding_type = "warning" NOT fail (trust verification over text match)
- Be SKEPTICAL. Assume claims are false until proven by log evidence OR system state.
- Return ONLY the JSON array, no markdown.`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const { work_order_id, agent_id, findings, evidence_requests } = body;

    if (!work_order_id) {
      return new Response(JSON.stringify({ error: 'work_order_id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { supabase, anthropic } = initClients();
    const qaAgentId = agent_id || 'a53f20af-69e3-4768-99d1-72be21185af4';

    const { data: qaAgent } = await supabase.from('agents').select('*').eq('id', qaAgentId).single();
    if (!qaAgent) return new Response(JSON.stringify({ error: 'QA agent not found' }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const { data: wo, error: woError } = await supabase.from('work_orders')
      .select('*, qa_checklist').eq('id', work_order_id).single();
    if (woError || !wo) return new Response(JSON.stringify({ error: 'Work order not found', details: woError }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const { data: execLog } = await supabase.from('work_order_execution_log')
      .select('*').eq('work_order_id', work_order_id)
      .order('created_at', { ascending: false }).limit(50);

    // Run mutation verification before QA evaluation
    let mutationVerificationResults: any = null;
    try {
      const { data: verifyResults, error: verifyError } = await supabase.rpc('verify_mutations', {
        p_work_order_id: work_order_id
      });
      if (verifyError) {
        console.error('Mutation verification failed:', verifyError);
      } else {
        mutationVerificationResults = verifyResults;
        console.log('Mutation verification complete:', verifyResults);
      }
    } catch (e) {
      console.error('Error calling verify_mutations:', e);
    }

    // Handle evidence requests
    if (evidence_requests?.length > 0) {
      const responses = [];
      for (const request of evidence_requests) {
        const { data: finding } = await supabase.from('qa_findings').select('*').eq('id', request.finding_id).single();
        if (!finding) continue;
        const msg = await anthropic.messages.create({
          model: 'claude-opus-4-6', max_tokens: 2000,
          messages: [{ role: 'user', content: `QA evidence review.\nFinding: ${finding.description}\nCategory: ${finding.category}\nSeverity: ${finding.finding_type}\nQuestion: ${request.question}\nEvidence type needed: ${request.required_evidence_type}\nExecution log:\n${JSON.stringify(execLog?.slice(0, 10), null, 2)}\nWO status: ${wo.status}, objective: ${wo.objective}, summary: ${wo.summary}\nRespond in JSON: {evidence_found: bool, details: string, satisfies_finding: bool}` }]
        });
        const txt = msg.content[0].type === 'text' ? msg.content[0].text : '';
        let parsed; try { parsed = JSON.parse(txt); } catch { parsed = { raw_response: txt }; }
        responses.push({ finding_id: request.finding_id, request: request.question, response: parsed });
        await supabase.from('qa_findings').update({
          evidence: { ...finding.evidence, evidence_response: parsed, evidence_requested_at: new Date().toISOString() }
        }).eq('id', request.finding_id);
        await supabase.from('audit_log').insert({
          event_type: 'qa_evidence_requested', actor_type: 'agent', actor_id: qaAgentId,
          target_type: 'qa_finding', target_id: request.finding_id, action: 'evidence_request',
          payload: { question: request.question, response: parsed }, work_order_id: work_order_id
        });
      }
      return new Response(JSON.stringify({ success: true, evidence_responses: responses,
        message: `Processed ${responses.length} evidence requests` }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Handle direct findings submission
    if (findings?.length > 0) {
      const result = await insertFindings(supabase, findings, work_order_id, qaAgentId);
      return new Response(JSON.stringify({
        success: true, findings: result.inserted,
        errors: result.errors.length > 0 ? result.errors : undefined,
        message: `Created ${result.inserted.length} findings${result.errors.length > 0 ? ` (${result.errors.length} errors)` : ''}`
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Default: Run LIE DETECTOR QA evaluation
    const acText = wo.acceptance_criteria || 'No acceptance criteria defined';
    const systemEvidence = await gatherSystemStateEvidence(supabase, acText, wo.summary, wo.objective);
    const prompt = buildLieDetectorPrompt(wo, execLog || [], acText, systemEvidence.text, systemEvidence.github_file_evidence, mutationVerificationResults);

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-6', max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    });

    const responseText = message.content[0].type === 'text' ? message.content[0].text : '';
    let evaluatedFindings: any[] = [];
    try {
      const jsonMatch = responseText.match(/\[.*\]/s);
      if (jsonMatch) evaluatedFindings = JSON.parse(jsonMatch[0]);
    } catch (e) { console.error('Failed to parse response:', e); }

    // Validate and enforce: unsupported claims MUST be fail
    for (const f of evaluatedFindings) {
      if (f.evidence?.verdict === 'unsupported' && f.finding_type !== 'fail') f.finding_type = 'fail';
    }

    const result = await insertFindings(supabase, evaluatedFindings, work_order_id, qaAgentId);

    // BUG FIX (restored from pre-WO-0398): Update ALL qa_checklist items based on findings.
    // The lie detector doesn't link findings to specific checklist_item_ids, so we must
    // update ALL items: pass if no blocking findings exist, fail if any do.
    // Without this, checklist items stay 'pending' and trg_auto_close_review_on_qa_pass never fires.
    const checklist = wo.qa_checklist || [];
    if (Array.isArray(checklist) && checklist.length > 0) {
      const hasAnyFail = result.inserted.some((f: any) =>
        f.finding_type === 'fail' || f.finding_type === 'error'
      );
      const hasAnyWarning = result.inserted.some((f: any) =>
        f.finding_type === 'warning'
      );
      const updatedChecklist = checklist.map((item: any) => {
        // Check for blocking findings linked to this specific item first
        const blockingFindings = result.inserted.filter((f: any) =>
          f.checklist_item_id === item.id &&
          (f.finding_type === 'fail' || f.finding_type === 'error')
        );
        // Item-specific fail takes priority, then global fail, then pass
        const status = blockingFindings.length > 0 ? 'fail' : (hasAnyFail ? 'fail' : 'pass');
        return {
          ...item,
          status,
          finding_id: blockingFindings[0]?.id || null,
        };
      });

      // Use bypass: trg_auto_close_review_on_qa_pass changes status to 'done',
      // which enforce_wo_state_changes blocks without bypass set first.
      try {
        const checklistJson = JSON.stringify(updatedChecklist).replace(/'/g, "''");
        await supabase.rpc('run_sql_void', {
          sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET qa_checklist = '${checklistJson}'::jsonb WHERE id = '${work_order_id}';`,
        });
      } catch (e) {
        console.error('Failed to update qa_checklist via bypass:', e);
        // Fallback: direct update (works if enforce only blocks status changes)
        await supabase.from('work_orders')
          .update({ qa_checklist: updatedChecklist })
          .eq('id', work_order_id);
      }
    }

    // Update last_qa_run_at
    await supabase.from('work_orders')
      .update({ last_qa_run_at: new Date().toISOString() })
      .eq('id', work_order_id);

    // Log evaluation
    await supabase.from('audit_log').insert({
      event_type: 'qa_evaluation_complete', actor_type: 'agent', actor_id: qaAgentId,
      target_type: 'work_order', target_id: work_order_id, action: 'evaluate',
      payload: { model: 'claude-opus-4-6', evaluation: 'lie_detector_v1',
        findings_count: result.inserted.length,
        fail_count: result.inserted.filter((f: any) => f.finding_type === 'fail').length,
        warning_count: result.inserted.filter((f: any) => f.finding_type === 'warning').length,
        has_warnings: result.inserted.some((f: any) => f.finding_type === 'warning') },
      work_order_id: work_order_id
    });

    return new Response(JSON.stringify({
      success: true, model: 'claude-opus-4-6', evaluation: 'lie_detector_v1',
      findings: result.inserted,
      errors: result.errors.length > 0 ? result.errors : undefined,
      summary: {
        total: result.inserted.length,
        fail: result.inserted.filter((f: any) => f.finding_type === 'fail').length,
        warning: result.inserted.filter((f: any) => f.finding_type === 'warning').length,
        info: result.inserted.filter((f: any) => f.finding_type === 'info').length,
        pass: result.inserted.filter((f: any) => f.finding_type === 'pass').length
      }
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('qa-review error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error', details: String(error) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
