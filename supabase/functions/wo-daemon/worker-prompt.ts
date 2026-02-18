// worker-prompt.ts
// WO-0121: Worker agent prompt template builder
// Loads template from system_settings and builds comprehensive worker context

export interface WorkerPromptTemplate {
  version: number;
  sections: {
    identity: string;
    harness_rules: string;
    deployment_rules: string;
    schema_gotchas: string;
    escalation_instructions: string;
  };
  dynamic_sections: {
    directives_query: string;
    lessons_query: string;
    context_load_api: string;
  };
}

/**
 * Load worker prompt template from system_settings
 */
export async function loadWorkerPromptTemplate(supabase: any): Promise<WorkerPromptTemplate | null> {
  try {
    const { data, error } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'worker_agent_prompt_template')
      .single();

    if (error || !data) {
      console.error('[PROMPT-TEMPLATE] Failed to load:', error);
      return null;
    }

    return data.setting_value as WorkerPromptTemplate;
  } catch (e) {
    console.error('[PROMPT-TEMPLATE] Exception:', e);
    return null;
  }
}

/**
 * Load active system directives, optionally filtered by WO tags.
 * WO-0164: If woTags provided, only loads directives whose applicable_tags
 * overlap with the WO tags, OR contain 'general' (always loaded).
 * Directives with context_filter='portal_only' are excluded for executor context.
 */
export async function loadActiveDirectives(supabase: any, woTags?: string[]): Promise<any[]> {
  try {
    const { data, error } = await supabase
      .from('system_directives')
      .select('id, name, content, priority, enforcement_mode, applicable_tags, context_filter')
      .eq('active', true)
      .neq('context_filter', 'portal_only')
      .order('priority', { ascending: false })
      .limit(20);

    if (error) {
      console.error('[DIRECTIVES] Failed to load:', error);
      return [];
    }

    if (!data) return [];

    // If no WO tags provided, return all executor-relevant directives (backwards compatible)
    if (!woTags || woTags.length === 0) return data;

    // Filter: directive's applicable_tags must overlap with WO tags OR contain 'general'
    const tagSet = new Set(woTags);
    return data.filter((dir: any) => {
      const dirTags: string[] = dir.applicable_tags || ['general'];
      if (dirTags.includes('general')) return true;
      return dirTags.some((t: string) => tagSet.has(t));
    });
  } catch (e) {
    console.error('[DIRECTIVES] Exception:', e);
    return [];
  }
}

/**
 * Load critical lessons
 */
export async function loadCriticalLessons(supabase: any): Promise<any[]> {
  try {
    const { data, error } = await supabase
      .from('lessons')
      .select('id, pattern, rule, example_good, severity, category')
      .eq('reviewed', true)
      .in('severity', ['critical', 'high'])
      .order('occurred_at', { ascending: false })
      .limit(10);

    if (error) {
      console.error('[LESSONS] Failed to load:', error);
      return [];
    }

    return data || [];
  } catch (e) {
    console.error('[LESSONS] Exception:', e);
    return [];
  }
}

/**
 * Load recent system context from context-load API
 */
export async function loadSystemContext(supabase: any): Promise<string> {
  try {
    const baseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const resp = await fetch(`${baseUrl}/functions/v1/context-load`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ context_type: 'system_status' }),
    });

    if (!resp.ok) {
      console.warn('[SYSTEM-CONTEXT] Failed to load, using minimal context');
      return '## System Status\nContext load unavailable';
    }

    const data = await resp.json();
    return data.context || '## System Status\nNo context available';

  } catch (e) {
    console.warn('[SYSTEM-CONTEXT] Exception:', e);
    return '## System Status\nContext load error';
  }
}

/**
 * Build comprehensive worker prompt from template + dynamic data
 * WO-0164: Accepts optional woTags for tag-filtered directive loading
 */
export async function buildWorkerPrompt(
  supabase: any,
  template: WorkerPromptTemplate,
  workerAgentName: string,
  schemaContext: string,
  woTags?: string[]
): Promise<string> {
  const sections: string[] = [];

  // 1. Worker Identity (with agent name injected)
  sections.push(template.sections.identity.replace(/\{\{AGENT_NAME\}\}/g, workerAgentName));
  sections.push('');

  // 2. Harness Rules
  sections.push(template.sections.harness_rules);
  sections.push('');

  // 3. Deployment Rules
  sections.push(template.sections.deployment_rules);
  sections.push('');

  // 4. Schema Gotchas (static template — supplemented by knowledge base)
  sections.push(template.sections.schema_gotchas);
  sections.push('');

  // 4b. KB loaded in buildAgentContext() — removed here to prevent double injection.

  // 5. Database Schema Context (already formatted)
  sections.push(schemaContext);
  sections.push('');

  // 6. Active Directives (filtered by WO tags if provided)
  const directives = await loadActiveDirectives(supabase, woTags);
  if (directives.length > 0) {
    sections.push('# ACTIVE SYSTEM DIRECTIVES');
    sections.push('');
    sections.push('The following directives are currently active and must be followed:');
    sections.push('');
    for (const dir of directives) {
      sections.push(`## ${dir.name} (priority: ${dir.priority}, enforcement: ${dir.enforcement_mode})`);
      sections.push(dir.content);
      sections.push('');
    }
  }

  // 7. Critical Lessons
  const lessons = await loadCriticalLessons(supabase);
  if (lessons.length > 0) {
    sections.push('# CRITICAL LESSONS LEARNED');
    sections.push('');
    sections.push('The following lessons were learned from past failures and MUST be applied:');
    sections.push('');
    for (const lesson of lessons) {
      sections.push(`## [${lesson.severity.toUpperCase()}] ${lesson.category}: ${lesson.pattern.slice(0, 100)}`);
      sections.push(`**Rule**: ${lesson.rule}`);
      if (lesson.example_good) {
        sections.push(`**Example**: ${lesson.example_good}`);
      }
      sections.push('');
    }
  }

  // 8. Recent System Context
  const systemContext = await loadSystemContext(supabase);
  sections.push('# SYSTEM CONTEXT (RECENT STATUS)');
  sections.push('');
  sections.push(systemContext);
  sections.push('');

  // 9. Escalation Instructions
  sections.push(template.sections.escalation_instructions);
  sections.push('');

  // 10. Footer
  sections.push('---');
  sections.push(`Worker Agent: ${workerAgentName}`);
  sections.push(`Prompt Template Version: ${template.version}`);
  sections.push(`Generated: ${new Date().toISOString()}`);
  sections.push('');

  return sections.join('\n');
}

/**
 * Load knowledge base entries filtered by agent role and WO tags.
 * - critical severity: always loaded
 * - important severity: loaded if applicable_roles overlaps agent role
 * - reference severity: loaded only if applicable_tags overlaps WO tags
 */
export async function loadKnowledgeBase(
  supabase: any,
  agentRole: string,
  woTags?: string[]
): Promise<string> {
  try {
    const { data, error } = await supabase
      .from('agent_knowledge_base')
      .select('category, topic, content, applicable_roles, applicable_tags, severity')
      .eq('active', true)
      .order('severity', { ascending: true })
      .order('category', { ascending: true });

    if (error || !data || data.length === 0) {
      console.warn('[KB] Failed to load or empty:', error?.message);
      return '';
    }

    // Map agent names to roles
    const ROLE_MAP: Record<string, string> = {
      'builder': 'executor',
      'ilmarinen': 'executor',
      'frontend': 'specialist',
      'qa-gate': 'evaluator',
      'ops': 'observer',
      'security': 'reviewer',
      'reviewer': 'reviewer',
      'user-portal': 'orchestrator',
      // Legacy compat (old names in historical data)
      'forgehand': 'executor',
      'sentinel': 'evaluator',
      'watchman': 'observer',
      'audit': 'reviewer',
      'metis': 'orchestrator',
    };
    const role = ROLE_MAP[agentRole] || 'general';
    const tagSet = new Set(woTags || []);

    const filtered = data.filter((entry: any) => {
      const roles: string[] = entry.applicable_roles || ['general'];
      const tags: string[] = entry.applicable_tags || ['general'];

      // Critical: always loaded
      if (entry.severity === 'critical') return true;

      // Important: loaded if role matches
      if (entry.severity === 'important') {
        return roles.includes('general') || roles.includes(role);
      }

      // Reference: loaded only if tags overlap
      if (entry.severity === 'reference') {
        if (tags.includes('general')) {
          return roles.includes('general') || roles.includes(role);
        }
        return tags.some((t: string) => tagSet.has(t));
      }

      return false;
    });

    if (filtered.length === 0) return '';

    // Group by category for readability
    const byCategory: Record<string, any[]> = {};
    for (const entry of filtered) {
      if (!byCategory[entry.category]) byCategory[entry.category] = [];
      byCategory[entry.category].push(entry);
    }

    let kb = '# INSTITUTIONAL KNOWLEDGE\n\n';
    kb += `Loaded ${filtered.length} entries for role="${role}" with ${tagSet.size} WO tags.\n\n`;

    for (const [cat, entries] of Object.entries(byCategory)) {
      kb += `## ${cat.replace(/_/g, ' ').toUpperCase()}\n`;
      for (const e of entries) {
        const sev = e.severity === 'critical' ? '[CRITICAL] ' : '';
        kb += `- ${sev}**${e.topic}**: ${e.content}\n`;
      }
      kb += '\n';
    }

    return kb;
  } catch (e) {
    console.error('[KB] Exception:', e);
    return '';
  }
}

/**
 * Generate unique worker agent name
 */
export function generateWorkerAgentName(workOrderSlug: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 6);
  return `worker-${workOrderSlug}-${timestamp}-${random}`;
}
