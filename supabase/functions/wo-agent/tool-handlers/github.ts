// wo-agent/tool-handlers/github.ts
// GitHub tools: read_file, write_file, edit_file (WO-0257), list_files, create_branch, create_pr (WO-0302)

import type { ToolContext, ToolResult } from "../tools.ts";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "Endgame-WO-Agent";

async function getGitHubToken(supabase: any): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("secrets")
      .select("value")
      .eq("key", "GITHUB_TOKEN")
      .single();
    if (error || !data?.value) return null;
    return data.value;
  } catch {
    return null;
  }
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
}

/**
 * Check if content contains UTF-8 corruption signature.
 * WO-0501: Detect multiply-encoded UTF-8 sequences that cause exponential file bloat.
 * Pattern: 4+ consecutive corrupted bytes (em-dash Ã¢ÂÂ ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ...)
 */
function detectUtf8Corruption(content: string): boolean {
  // Match 4+ consecutive occurrences of the corruption pattern
  // \xC3\x82 or \xC3\x83 are the byte sequences for corrupted multi-byte UTF-8
  const corruptionPattern = /(\xC3[\x82-\x83]){4,}/;
  return corruptionPattern.test(content);
}

/**
 * Check if a file was recently modified by another completed WO (anti-clobber guard).
 * WO-0400: Prevent silent overwrites when multiple WOs edit the same file.
 */
async function checkFileOverlap(
  supabase: any,
  workOrderId: string,
  filePath: string
): Promise<{ overlap: boolean; conflicting_wos: Array<{ slug: string; commit_sha: string }> }> {
  try {
    // Query execution_log for other done WOs that successfully modified this file
    const { data, error } = await supabase
      .from("work_order_execution_log")
      .select("work_order_id, detail")
      .in("detail->>tool_name", ["github_edit_file", "github_write_file"])
      .eq("detail->>success", "true")
      .neq("work_order_id", workOrderId)
      .ilike("detail->>content", `%${filePath}%`);

    if (error) {
      console.error("checkFileOverlap query error:", error);
      return { overlap: false, conflicting_wos: [] };
    }

    if (!data || data.length === 0) {
      return { overlap: false, conflicting_wos: [] };
    }

    // Filter to only WOs that are done, and extract slug + commit_sha
    const woIds = [...new Set(data.map((row: any) => row.work_order_id))];
    const { data: wos, error: woError } = await supabase
      .from("work_orders")
      .select("id, slug")
      .in("id", woIds)
      .eq("status", "done");

    if (woError || !wos || wos.length === 0) {
      return { overlap: false, conflicting_wos: [] };
    }

    // Extract commit_sha from detail for each matching WO
    const conflicting_wos = wos.map((wo: any) => {
      const logEntry = data.find((row: any) => row.work_order_id === wo.id);
      let commit_sha = "unknown";
      try {
        // Content field is stringified JSON containing commit_sha
        if (logEntry?.detail?.content) {
          const parsed = JSON.parse(logEntry.detail.content);
          commit_sha = parsed.commit_sha || "unknown";
        }
      } catch {
        commit_sha = "unknown";
      }
      return { slug: wo.slug, commit_sha };
    });

    return {
      overlap: conflicting_wos.length > 0,
      conflicting_wos,
    };
  } catch (e: any) {
    console.error("checkFileOverlap exception:", e);
    return { overlap: false, conflicting_wos: [] };
  }
}

export async function handleGithubReadFile(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { repo, path, branch } = input;
  if (!repo || !path) {
    return { success: false, error: "Missing required parameters: repo, path" };
  }

  const token = ctx.githubToken || (await getGitHubToken(ctx.supabase));
  if (!token) {
    return { success: false, error: "GitHub token not available" };
  }

  try {
    const ref = branch || "main";
    const resp = await fetch(
      `${GITHUB_API}/repos/${repo}/contents/${path}?ref=${ref}`,
      { headers: githubHeaders(token) }
    );

    if (resp.status === 404) {
      return { success: false, error: `File not found: ${repo}/${path} (branch: ${ref})` };
    }
    if (!resp.ok) {
      const errText = await resp.text();
      return { success: false, error: `GitHub API error ${resp.status}: ${errText}` };
    }

    const data = await resp.json();
    // Decode base64 content
    let content = atob(data.content.replace(/\n/g, ""));

    // WO-0484: Warn if file may be truncated
    if (content.length > 10000) {
      content = "WARNING: File content may be truncated at ~10k chars by GitHub API\n\n" + content;
    }

    return {
      success: true,
      data: { content, sha: data.sha, size: data.size, path: data.path },
    };
  } catch (e: any) {
    return { success: false, error: `github_read_file exception: ${e.message}` };
  }
}

export async function handleGithubWriteFile(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { repo, path, content, message, branch } = input;
  if (!repo || !path || !content || !message) {
    return {
      success: false,
      error: "Missing required parameters: repo, path, content, message",
    };
  }

  const token = ctx.githubToken || (await getGitHubToken(ctx.supabase));
  if (!token) {
    return { success: false, error: "GitHub token not available" };
  }

  try {
    const ref = branch || "main";

    // WO-0400: Check for file overlap before writing
    const overlapCheck = await checkFileOverlap(ctx.supabase, ctx.workOrderId, path);
    if (overlapCheck.overlap) {
      // Log warning to execution_log
      await ctx.supabase.from("work_order_execution_log").insert({
        work_order_id: ctx.workOrderId,
        phase: "stream",
        agent_name: "builder",
        detail: {
          event_type: "destructive_overlap_warning",
          file_path: path,
          conflicting_wos: overlapCheck.conflicting_wos,
        },
      });
    }

    // Get existing SHA if file exists
    let sha: string | null = null;
    try {
      const checkResp = await fetch(
        `${GITHUB_API}/repos/${repo}/contents/${path}?ref=${ref}`,
        { headers: githubHeaders(token) }
      );
      if (checkResp.ok) {
        const existing = await checkResp.json();
        sha = existing.sha;
      }
    } catch {
      // File doesn't exist, that's fine
    }

    // WO-0501: Check for UTF-8 corruption before committing
    if (detectUtf8Corruption(content)) {
      return {
        success: false,
        error: "UTF-8 corruption detected in file content â aborting commit to prevent data loss. Content contains multiply-encoded byte sequences (ÃÃÃÃ...) that indicate encoding errors.",
      };
    }

    const encodedContent = btoa(unescape(encodeURIComponent(content)));
    const body: any = { message, content: encodedContent, branch: ref };
    if (sha) body.sha = sha;

    const resp = await fetch(`${GITHUB_API}/repos/${repo}/contents/${path}`, {
      method: "PUT",
      headers: githubHeaders(token),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return { success: false, error: `GitHub write error ${resp.status}: ${errText}` };
    }

    const result = await resp.json();
    
    // WO-0400: Prepend warning if overlap detected
    let resultMessage = `Wrote ${path} to ${repo}`;
    if (overlapCheck.overlap) {
      const conflictingSlugs = overlapCheck.conflicting_wos.map((w: any) => w.slug).join(", ");
      resultMessage = `WARNING: ${path} was last modified by ${conflictingSlugs}. Verify changes preserve prior work.\n\n${resultMessage}`;
    }
    
    return {
      success: true,
      data: {
        commit_sha: result.commit?.sha,
        html_url: result.content?.html_url,
        message: resultMessage,
      },
    };
  } catch (e: any) {
    return { success: false, error: `github_write_file exception: ${e.message}` };
  }
}

export async function handleGithubEditFile(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { path, old_string, new_string, message, branch } = input;
  const repo = input.repo || "olivergale/metis-portal2";

  if (!path || old_string === undefined || new_string === undefined) {
    return { success: false, error: "Missing required parameters: path, old_string, new_string" };
  }

  const token = ctx.githubToken || (await getGitHubToken(ctx.supabase));
  if (!token) {
    return { success: false, error: "GitHub token not available" };
  }

  try {
    const ref = branch || "main";

    // WO-0400: Check for file overlap before editing
    const overlapCheck = await checkFileOverlap(ctx.supabase, ctx.workOrderId, path);
    if (overlapCheck.overlap) {
      // Log warning to execution_log
      await ctx.supabase.from("work_order_execution_log").insert({
        work_order_id: ctx.workOrderId,
        phase: "stream",
        agent_name: "builder",
        detail: {
          event_type: "destructive_overlap_warning",
          file_path: path,
          conflicting_wos: overlapCheck.conflicting_wos,
        },
      });
    }

    // 1. Read current file
    const readResp = await fetch(
      `${GITHUB_API}/repos/${repo}/contents/${path}?ref=${ref}`,
      { headers: githubHeaders(token) }
    );

    if (!readResp.ok) {
      const errText = await readResp.text();
      return { success: false, error: `Cannot read ${path}: ${readResp.status} ${errText}` };
    }

    const fileData = await readResp.json();
    const currentContent = atob(fileData.content.replace(/\n/g, ""));
    const sha = fileData.sha;

    // 2. Verify old_string exists and is unique
    const idx = currentContent.indexOf(old_string);
    if (idx === -1) {
      return { success: false, error: `old_string not found in ${path}. Ensure exact match including whitespace.` };
    }
    const lastIdx = currentContent.lastIndexOf(old_string);
    if (idx !== lastIdx) {
      return { success: false, error: `old_string appears multiple times in ${path}. Provide a more unique string.` };
    }

    // 3. Replace
    const updatedContent = currentContent.replace(old_string, new_string);

    // WO-0501: Check for UTF-8 corruption before committing
    if (detectUtf8Corruption(updatedContent)) {
      return {
        success: false,
        error: "UTF-8 corruption detected in file content — aborting commit to prevent data loss. Content contains multiply-encoded byte sequences (ÃÂÃÂ...) that indicate encoding errors.",
      };
    }

    // 4. Write back
    const originalSize = fileData.size;
    const encodedContent = btoa(unescape(encodeURIComponent(updatedContent)));
    const commitMsg = message || `Edit ${path} via github_edit_file`;

    const writeResp = await fetch(`${GITHUB_API}/repos/${repo}/contents/${path}`, {
      method: "PUT",
      headers: githubHeaders(token),
      body: JSON.stringify({ message: commitMsg, content: encodedContent, sha, branch: ref }),
    });

    if (!writeResp.ok) {
      const errText = await writeResp.text();
      return { success: false, error: `GitHub write error ${writeResp.status}: ${errText}` };
    }

    const result = await writeResp.json();
    
    // WO-0400: Prepend warning if overlap detected
    let resultMessage = `Edited ${path} in ${repo} (replaced ${old_string.length} chars with ${new_string.length} chars)`;
    if (overlapCheck.overlap) {
      const conflictingSlugs = overlapCheck.conflicting_wos.map((w: any) => w.slug).join(", ");
      resultMessage = `WARNING: ${path} was last modified by ${conflictingSlugs}. Verify changes preserve prior work.\n\n${resultMessage}`;
    }
    
    return {
      success: true,
      data: {
        commit_sha: result.commit?.sha,
        html_url: result.content?.html_url,
        message: resultMessage,
      },
    };
  } catch (e: any) {
    return { success: false, error: `github_edit_file exception: ${e.message}` };
  }
}

export async function handleGithubPatchFile(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { path, patches, message, branch } = input;
  const repo = input.repo || "olivergale/metis-portal2";

  if (!path || !patches || !Array.isArray(patches) || patches.length === 0) {
    return { success: false, error: "Missing required parameters: path, patches (array of {search, replace})" };
  }

  const token = ctx.githubToken || (await getGitHubToken(ctx.supabase));
  if (!token) {
    return { success: false, error: "GitHub token not available" };
  }

  try {
    const ref = branch || "main";

    // 1. Read full file (no size limit -- this runs server-side)
    const readResp = await fetch(
      `${GITHUB_API}/repos/${repo}/contents/${path}?ref=${ref}`,
      { headers: githubHeaders(token) }
    );

    if (readResp.status === 404) {
      return { success: false, error: `File not found: ${repo}/${path} (branch: ${ref})` };
    }
    if (!readResp.ok) {
      const errText = await readResp.text();
      return { success: false, error: `Cannot read ${path}: ${readResp.status} ${errText}` };
    }

    const fileData = await readResp.json();
    const currentContent = atob(fileData.content.replace(/\n/g, ""));
    const sha = fileData.sha;

    // 2. Apply patches sequentially
    let content = currentContent;
    const applied: string[] = [];
    for (let i = 0; i < patches.length; i++) {
      const patch = patches[i];
      if (!patch.search || patch.replace === undefined) {
        return { success: false, error: `Patch ${i}: missing 'search' or 'replace' field` };
      }
      const idx = content.indexOf(patch.search);
      if (idx === -1) {
        return { success: false, error: `Patch ${i}: search string not found in ${path}. First 80 chars: "${patch.search.slice(0, 80)}"` };
      }
      content = content.replace(patch.search, patch.replace);
      applied.push(`Patch ${i}: replaced ${patch.search.length} chars with ${patch.replace.length} chars`);
    }

    // 3. Write back
    const encodedContent = btoa(unescape(encodeURIComponent(content)));
    const commitMsg = message || `Patch ${path} via github_patch_file (${patches.length} patches)`;

    const writeResp = await fetch(`${GITHUB_API}/repos/${repo}/contents/${path}`, {
      method: "PUT",
      headers: githubHeaders(token),
      body: JSON.stringify({ message: commitMsg, content: encodedContent, sha, branch: ref }),
    });

    if (!writeResp.ok) {
      const errText = await writeResp.text();
      return { success: false, error: `GitHub write error ${writeResp.status}: ${errText}` };
    }

    const result = await writeResp.json();
    return {
      success: true,
      data: {
        commit_sha: result.commit?.sha,
        html_url: result.content?.html_url,
        patches_applied: applied.length,
        details: applied,
        message: `Patched ${path} in ${repo} (${applied.length} patches)`,
      },
    };
  } catch (e: any) {
    return { success: false, error: `github_patch_file exception: ${e.message}` };
  }
}

export async function handleGithubListFiles(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { repo, path, branch } = input;
  if (!repo) {
    return { success: false, error: "Missing required parameter: repo" };
  }

  const token = ctx.githubToken || (await getGitHubToken(ctx.supabase));
  if (!token) {
    return { success: false, error: "GitHub token not available" };
  }

  try {
    const ref = branch || "main";
    const dirPath = path || "";
    const resp = await fetch(
      `${GITHUB_API}/repos/${repo}/contents/${dirPath}?ref=${ref}`,
      { headers: githubHeaders(token) }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      return { success: false, error: `GitHub API error ${resp.status}: ${errText}` };
    }

    const data = await resp.json();
    if (!Array.isArray(data)) {
      return { success: false, error: `Path is a file, not a directory: ${dirPath}` };
    }

    const items = data.map((item: any) => ({
      name: item.name,
      path: item.path,
      type: item.type,
      size: item.size,
      sha: item.sha,
    }));

    return { success: true, data: { path: dirPath, items, count: items.length } };
  } catch (e: any) {
    return { success: false, error: `github_list_files exception: ${e.message}` };
  }
}

export async function handleGithubCreateBranch(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { repo, branch, from_branch } = input;
  if (!repo || !branch) {
    return { success: false, error: "Missing required parameters: repo, branch" };
  }

  const token = ctx.githubToken || (await getGitHubToken(ctx.supabase));
  if (!token) {
    return { success: false, error: "GitHub token not available" };
  }

  try {
    const base = from_branch || "main";
    // Get SHA of base branch
    const refResp = await fetch(
      `${GITHUB_API}/repos/${repo}/git/ref/heads/${base}`,
      { headers: githubHeaders(token) }
    );

    if (!refResp.ok) {
      const errText = await refResp.text();
      return { success: false, error: `Cannot find base branch '${base}': ${refResp.status} ${errText}` };
    }

    const refData = await refResp.json();
    const sha = refData.object.sha;

    // Create new branch
    const createResp = await fetch(`${GITHUB_API}/repos/${repo}/git/refs`, {
      method: "POST",
      headers: githubHeaders(token),
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
    });

    if (!createResp.ok) {
      const errText = await createResp.text();
      return { success: false, error: `Failed to create branch: ${createResp.status} ${errText}` };
    }

    return {
      success: true,
      data: { branch, from_branch: base, sha, message: `Created branch '${branch}' from '${base}'` },
    };
  } catch (e: any) {
    return { success: false, error: `github_create_branch exception: ${e.message}` };
  }
}

export async function handleGithubCreatePr(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { repo, head, base, title, body } = input;
  if (!repo || !head || !title) {
    return { success: false, error: "Missing required parameters: repo, head, title" };
  }

  const token = ctx.githubToken || (await getGitHubToken(ctx.supabase));
  if (!token) {
    return { success: false, error: "GitHub token not available" };
  }

  try {
    const resp = await fetch(`${GITHUB_API}/repos/${repo}/pulls`, {
      method: "POST",
      headers: githubHeaders(token),
      body: JSON.stringify({
        title,
        body: body || "",
        head,
        base: base || "main",
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return { success: false, error: `Failed to create PR: ${resp.status} ${errText}` };
    }

    const pr = await resp.json();
    return {
      success: true,
      data: {
        pr_number: pr.number,
        html_url: pr.html_url,
        state: pr.state,
        message: `Created PR #${pr.number}: ${title}`,
      },
    };
  } catch (e: any) {
    return { success: false, error: `github_create_pr exception: ${e.message}` };
  }
}

export async function handleGithubSearchCode(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { query, path_filter } = input;
  if (!query) {
    return { success: false, error: "Missing required parameter: query" };
  }

  const token = ctx.githubToken || (await getGitHubToken(ctx.supabase));
  if (!token) {
    return { success: false, error: "GitHub token not available" };
  }

  try {
    // Build search query: always scope to olivergale/metis-portal2 repo
    let searchQuery = `${query} repo:olivergale/metis-portal2`;
    if (path_filter) {
      searchQuery += ` path:${path_filter}`;
    }

    const resp = await fetch(
      `${GITHUB_API}/search/code?q=${encodeURIComponent(searchQuery)}&per_page=10`,
      { headers: githubHeaders(token) }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      return { success: false, error: `GitHub search error ${resp.status}: ${errText}` };
    }

    const data = await resp.json();
    
    // Extract top 10 results with file path and text matches
    const results = data.items?.slice(0, 10).map((item: any) => ({
      path: item.path,
      repository: item.repository?.full_name,
      html_url: item.html_url,
      // GitHub Code Search API returns text_matches when available
      matches: item.text_matches?.map((match: any) => ({
        fragment: match.fragment, // 3 lines of context around match
        line_start: match.object_url, // Contains line number info
      })) || [],
    })) || [];

    return {
      success: true,
      data: {
        query: searchQuery,
        total_count: data.total_count,
        results,
        message: `Found ${data.total_count} results for "${query}" (showing top ${results.length})`,
      },
    };
  } catch (e: any) {
    return { success: false, error: `github_search_code exception: ${e.message}` };
  }
}
