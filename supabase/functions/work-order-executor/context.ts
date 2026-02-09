// context.ts - Repository context loading for builder agent
// Provides code-aware context by reading GitHub repo tree and injecting relevant paths

interface RepoTreeItem {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
  url: string;
}

interface RepoContext {
  edgeFunctions: string[];
  migrations: string[];
  frontendComponents: string[];
  keyFiles: string[];
}

/**
 * Load repository context via GitHub API tree endpoint
 * Only loads for WOs that involve code changes (check tags or objective keywords)
 */
export async function loadRepoContext(
  workOrder: { tags?: string[]; objective?: string; name?: string },
  githubToken?: string
): Promise<string | null> {
  // Check if WO involves code changes
  const codeRelatedTags = ['supabase', 'migration', 'schema', 'edge-function', 'frontend', 'portal-frontend', 'deployment', 'rollback'];
  const codeKeywords = ['deploy', 'function', 'migration', 'schema', 'edge', 'frontend', 'component', 'api', 'endpoint', 'table', 'rpc', 'trigger'];
  
  const hasCodeTag = workOrder.tags?.some(tag => codeRelatedTags.includes(tag));
  const objectiveText = `${workOrder.objective || ''} ${workOrder.name || ''}`.toLowerCase();
  const hasCodeKeyword = codeKeywords.some(kw => objectiveText.includes(kw));
  
  if (!hasCodeTag && !hasCodeKeyword) {
    return null; // Skip context loading for non-code WOs
  }

  try {
    // Use GitHub API to get repo tree
    const repo = 'olivergale/metis-portal2';
    const branch = 'main';
    
    // Get tree recursively (limited to 100,000 entries by GitHub)
    const token = githubToken || Deno.env.get('GITHUB_TOKEN');
    if (!token) {
      console.warn('[REPO_CONTEXT] No GitHub token available, skipping repo context');
      return null;
    }

    const response = await fetch(
      `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'metis-portal-wo-agent'
        }
      }
    );

    if (!response.ok) {
      console.warn(`[REPO_CONTEXT] GitHub API error: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json();
    const tree: RepoTreeItem[] = data.tree || [];

    // Filter and categorize relevant paths
    const context: RepoContext = {
      edgeFunctions: [],
      migrations: [],
      frontendComponents: [],
      keyFiles: []
    };

    for (const item of tree) {
      if (item.type !== 'blob') continue; // Skip directories

      const path = item.path;

      // Edge functions
      if (path.startsWith('supabase/functions/') && path.endsWith('/index.ts')) {
        const functionName = path.split('/')[2];
        context.edgeFunctions.push(functionName);
      }

      // Migrations
      if (path.startsWith('supabase/migrations/') && path.endsWith('.sql')) {
        context.migrations.push(path.replace('supabase/migrations/', ''));
      }

      // Frontend components (key directories only)
      if (path.startsWith('src/')) {
        if (path.match(/src\/components\/.*\.tsx?$/)) {
          context.frontendComponents.push(path.replace('src/', ''));
        } else if (path.match(/src\/(pages|hooks|utils|lib)\/.*\.tsx?$/)) {
          context.keyFiles.push(path.replace('src/', ''));
        }
      }

      // Other key files
      if (path.match(/^(package\.json|tsconfig\.json|vite\.config\.ts|supabase\/config\.toml)$/)) {
        context.keyFiles.push(path);
      }
    }

    // Build markdown context section
    const sections: string[] = ['# CODEBASE CONTEXT', ''];
    
    if (context.edgeFunctions.length > 0) {
      sections.push('## Edge Functions');
      sections.push('Available edge functions in `supabase/functions/`:');
      // Show top 30 most relevant
      const sortedFunctions = context.edgeFunctions.sort();
      const displayCount = Math.min(30, sortedFunctions.length);
      sections.push(...sortedFunctions.slice(0, displayCount).map(fn => `- ${fn}/index.ts`));
      if (sortedFunctions.length > displayCount) {
        sections.push(`- ... (${sortedFunctions.length - displayCount} more)`);
      }
      sections.push('');
    }

    if (context.migrations.length > 0) {
      sections.push('## Database Migrations');
      sections.push('Migration files in `supabase/migrations/`:');
      // Show last 10 migrations (most recent)
      const recentMigrations = context.migrations.sort().reverse().slice(0, 10);
      sections.push(...recentMigrations.map(m => `- ${m}`));
      if (context.migrations.length > 10) {
        sections.push(`- ... (${context.migrations.length - 10} older migrations)`);
      }
      sections.push('');
    }

    if (context.frontendComponents.length > 0) {
      sections.push('## Frontend Components');
      sections.push('Key components in `src/components/`:');
      // Show top 20 components
      const sortedComponents = context.frontendComponents.sort();
      const displayCount = Math.min(20, sortedComponents.length);
      sections.push(...sortedComponents.slice(0, displayCount).map(c => `- ${c}`));
      if (sortedComponents.length > displayCount) {
        sections.push(`- ... (${sortedComponents.length - displayCount} more)`);
      }
      sections.push('');
    }

    if (context.keyFiles.length > 0) {
      sections.push('## Key Source Files');
      sections.push(...context.keyFiles.sort().map(f => `- ${f}`));
      sections.push('');
    }

    sections.push('**Note**: Use `github_read_file` to read specific files. Paths are relative to repo root (olivergale/metis-portal2).');
    sections.push('');

    const contextMarkdown = sections.join('\n');
    console.log(`[REPO_CONTEXT] Loaded context: ${context.edgeFunctions.length} functions, ${context.migrations.length} migrations, ${context.frontendComponents.length} components`);
    
    return contextMarkdown;

  } catch (error) {
    console.error('[REPO_CONTEXT] Error loading repo context:', error);
    return null;
  }
}

/**
 * Inject repo context into system prompt
 * Returns modified prompt with CODEBASE CONTEXT section added before SYSTEM CONTEXT
 */
export function injectRepoContext(basePrompt: string, repoContext: string | null): string {
  if (!repoContext) {
    return basePrompt;
  }

  // Find insertion point - before "# SYSTEM CONTEXT" or at end
  const systemContextIndex = basePrompt.indexOf('# SYSTEM CONTEXT');
  
  if (systemContextIndex !== -1) {
    return basePrompt.slice(0, systemContextIndex) + repoContext + '\n' + basePrompt.slice(systemContextIndex);
  } else {
    // Append at end if no SYSTEM CONTEXT section found
    return basePrompt + '\n\n' + repoContext;
  }
}
