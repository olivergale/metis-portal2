// wo-agent/tool-handlers/github.ts
// GitHub tools: read_file, write_file, edit_file (WO-0257), list_files, create_branch, create_pr (WO-0302)

import type { ToolContext, ToolResult } from "../tools.ts";
// K014: validateFileContent import removed — only consumer was deprecated handleGithubEditFile

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "Endgame-WO-Agent";

/**
 * WO-0594: Call Fly Machine sandbox to verify file integrity after push.
 * Returns { verified: boolean, actualBytes: number, error?: string }
 */
async function verifyPushedFile(
  ctx: ToolContext,
  filePath: string,
  expectedContentLength: number
): Promise<{ verified: boolean; actualBytes: number; error?: string }> {
  try {
    // Read Fly Machine config from system_settings
    const { data: flySettings } = await ctx.supabase
      .from("system_settings")
      .select("setting_key, setting_value")
      .in("setting_key", ["fly_machine_url", "fly_machine_token"]);
    
    const flyUrl = flySettings?.find((s: any) => s.setting_key === "fly_machine_url")?.setting_value;
    const flyToken = flySettings?.find((s: any) => s.setting_key === "fly_machine_token")?.setting_value;

    if (!flyUrl) {
      return { verified: false, actualBytes: 0, error: "Fly Machine URL not configured" };
    }

    // First git-pull to ensure sandbox has latest (if not already pulled this WO)
    if (!(globalThis as any)._flyGitPulled) {
      (globalThis as any)._flyGitPulled = new Set<string>();
    }
    const pulledSet = (globalThis as any)._flyGitPulled as Set<string>;
    if (!pulledSet.has(ctx.workOrderId)) {
      try {
        await fetch(`${flyUrl}/git-pull`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        pulledSet.add(ctx.workOrderId);
      } catch { /* non-fatal */ }
    }

    // Call wc -c to get actual byte count
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (flyToken && flyToken !== "not_required_public_endpoint") {
      headers["Authorization"] = `Bearer ${flyToken}`;
    }

    const wcResp = await fetch(`${flyUrl}/exec`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        command: "wc",
        args: ["-c", filePath],
        timeout_ms: 30000,
        wo_slug: ctx.workOrderSlug,
      }),
    });

    if (!wcResp.ok) {
      return { verified: false, actualBytes: 0, error: `wc -c failed: ${wcResp.status}` };
    }

    const wcResult = await wcResp.json();
    const wcOutput = (wcResult.stdout || "").trim();
    const actualBytes = parseInt(wcOutput.split(/\s+/)[0], 10) || 0;

    // Check byte count mismatch
    const mismatchPercent = expectedContentLength > 0 
      ? Math.abs(actualBytes - expectedContentLength) / expectedContentLength * 100 
      : 0;
    
    const verified = mismatchPercent <= 5;
    
    return { verified, actualBytes };
  } catch (e: any) {
    return { verified: false, actualBytes: 0, error: e.message };
  }
}

/**
 * Record verification result to execution_log.
 * WO-0594: Log verification result via recordMutation with verified=true/false
 */
async function logVerification(
  ctx: ToolContext,
  filePath: string,
  verified: boolean,
  actualBytes: number,
  expectedBytes: number,
  error?: string
): Promise<void> {
  try {
    await ctx.supabase.from("work_order_execution_log").insert({
      work_order_id: ctx.workOrderId,
      phase: "stream",
      agent_name: ctx.agentName,
      detail: {
        event_type: "file_verification",
        tool_name: "github_push_files",
        file_path: filePath,
        verified,
        actual_bytes: actualBytes,
        expected_bytes: expectedBytes,
        mismatch_percent: expectedBytes > 0 ? Math.abs(actualBytes - expectedBytes) / expectedBytes * 100 : 0,
        error,
      },
    });
  } catch (e: any) {
    console.warn("[logVerification] Failed to log verification:", e.message);
  }
}

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

// K014: detectUtf8Corruption + checkFileOverlap removed — only consumers were deprecated handleGithubWriteFile/handleGithubEditFile

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

// K014: Removed handleGithubWriteFile, handleGithubEditFile, handleGithubPatchFile, handlePatchFile,
// detectUtf8Corruption, checkFileOverlap. All replaced by handleGithubPushFiles (Git Data API). See WO-0588.

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

export async function handleGithubGrep(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { pattern, path, branch } = input;
  const repo = input.repo || "olivergale/metis-portal2";
  
  if (!pattern) {
    return { success: false, error: "Missing required parameter: pattern" };
  }

  const token = ctx.githubToken || (await getGitHubToken(ctx.supabase));
  if (!token) {
    return { success: false, error: "GitHub token not available" };
  }

  try {
    // Build search query using GitHub Code Search API
    let searchQuery = `${pattern} repo:${repo}`;
    if (path) {
      searchQuery += ` path:${path}`;
    }

    const headers = {
      ...githubHeaders(token),
      Accept: "application/vnd.github.text-match+json",
    };

    const resp = await fetch(
      `${GITHUB_API}/search/code?q=${encodeURIComponent(searchQuery)}&per_page=10`,
      { headers }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      return { success: false, error: `GitHub Code Search error ${resp.status}: ${errText}` };
    }

    const data = await resp.json();
    
    // Extract matches with file_path and matched_line
    const matches = data.items?.slice(0, 10).map((item: any) => {
      // Extract matched lines from text_matches if available
      const matchedLines: string[] = [];
      if (item.text_matches && Array.isArray(item.text_matches)) {
        item.text_matches.forEach((match: any) => {
          if (match.fragment) {
            matchedLines.push(match.fragment);
          }
        });
      }
      
      return {
        file_path: item.path,
        matched_line: matchedLines.length > 0 ? matchedLines[0] : "(line content not available)",
        html_url: item.html_url,
      };
    }) || [];

    return {
      success: true,
      data: {
        pattern,
        repo,
        path_filter: path || "(all paths)",
        total_count: data.total_count,
        matches,
        message: `Found ${matches.length} matches for pattern "${pattern}" in ${repo}`,
      },
    };
  } catch (e: any) {
    return { success: false, error: `github_grep exception: ${e.message}` };
  }
}

export async function handleGithubReadFileRange(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { path, start_line, end_line, branch } = input;
  const repo = input.repo || "olivergale/metis-portal2";

  if (!path || start_line === undefined || end_line === undefined) {
    return { success: false, error: "Missing required parameters: path, start_line, end_line" };
  }

  if (start_line < 1 || end_line < start_line) {
    return { success: false, error: "Invalid line range: start_line must be >= 1 and end_line >= start_line" };
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
    // Decode full base64 content (no truncation)
    const fullContent = atob(data.content.replace(/\n/g, ""));
    
    // Split by newline and extract requested range (1-indexed)
    const lines = fullContent.split("\n");
    const totalLines = lines.length;
    
    // Validate range
    if (start_line > totalLines) {
      return { success: false, error: `start_line ${start_line} exceeds file length (${totalLines} lines)` };
    }
    
    const actualEndLine = Math.min(end_line, totalLines);
    const selectedLines = lines.slice(start_line - 1, actualEndLine);
    
    // Add line number prefix (1-indexed)
    const numberedLines = selectedLines.map((line, idx) => 
      `${start_line + idx}: ${line}`
    ).join("\n");

    return {
      success: true,
      data: {
        path,
        repo,
        branch: ref,
        start_line,
        end_line: actualEndLine,
        total_lines: totalLines,
        content: numberedLines,
        line_count: selectedLines.length,
      },
    };
  } catch (e: any) {
    return { success: false, error: `github_read_file_range exception: ${e.message}` };
  }
}

/**
 * Call Fly Machine sandbox exec for verification
 * WO-0594: Extracts verification logic for reuse
 */
async function callSandboxExec(
  supabase: any,
  workOrderId: string,
  workOrderSlug: string,
  command: string,
  args: string[],
  timeoutMs: number = 30000
): Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number }> {
  try {
    // Read Fly Machine URL from system_settings
    const { data: flySettings } = await supabase
      .from("system_settings")
      .select("setting_key, setting_value")
      .in("setting_key", ["fly_machine_url", "fly_machine_token"]);
    const flyUrl = flySettings?.find((s: any) => s.setting_key === "fly_machine_url")?.setting_value;
    const flyToken = flySettings?.find((s: any) => s.setting_key === "fly_machine_token")?.setting_value;

    if (!flyUrl) {
      return { success: false, stdout: "", stderr: "Fly Machine URL not configured", exitCode: -1 };
    }

    // Git-pull-on-demand: pull latest before verification
    // WO-0594: Need fresh content after github_push_files
    try {
      const pullCtrl = new AbortController();
      const pullTimer = setTimeout(() => pullCtrl.abort(), 60000);
      await fetch(`${flyUrl}/git-pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: pullCtrl.signal,
        body: "{}",
      });
      clearTimeout(pullTimer);
    } catch (_pullErr) {
      // Non-fatal: continue with verification
    }

    // Call Fly Machine /exec endpoint
    const execCtrl = new AbortController();
    const execTimer = setTimeout(() => execCtrl.abort(), timeoutMs);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (flyToken && flyToken !== "not_required_public_endpoint") {
      headers["Authorization"] = `Bearer ${flyToken}`;
    }
    const response = await fetch(`${flyUrl}/exec`, {
      method: "POST",
      headers,
      signal: execCtrl.signal,
      body: JSON.stringify({
        command,
        args,
        timeout_ms: timeoutMs,
        wo_slug: workOrderSlug,
      }),
    });
    clearTimeout(execTimer);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: response.statusText }));
      return { success: false, stdout: "", stderr: errorData.error || response.statusText, exitCode: -1 };
    }

    const execResult = await response.json();
    return {
      success: execResult.exit_code === 0,
      stdout: execResult.stdout || "",
      stderr: execResult.stderr || "",
      exitCode: execResult.exit_code || -1,
    };
  } catch (e: any) {
    return { success: false, stdout: "", stderr: e.message, exitCode: -1 };
  }
}

/**
 * Record mutation verification result
 * WO-0594: Log verification success/failure
 */
async function recordVerification(
  supabase: any,
  workOrderId: string,
  toolName: string,
  objectId: string,
  verified: boolean,
  context: Record<string, any>
): Promise<void> {
  try {
    await supabase.rpc("record_mutation", {
      p_work_order_id: workOrderId,
      p_tool_name: toolName,
      p_object_type: "verification",
      p_object_id: objectId,
      p_action: "VERIFY",
      p_success: true,
      p_verified: verified,
      p_context: context,
      p_agent_name: "builder",
    });
  } catch (e: any) {
    console.warn(`[recordVerification] Failed: ${e.message}`);
  }
}

/**
 * github_push_files: Atomic multi-file commits via Git Data API.
 * Replaces github_write_file, github_edit_file, github_patch_file.
 * Uses blobs (UTF-8 encoding) instead of Contents API (base64) to eliminate
 * the base64 round-trip that causes UTF-8 corruption on multi-byte chars.
 *
 * Two modes per file:
 * - content: full file content (for new files or full rewrites)
 * - patches: [{search, replace}] applied to current file (reads via raw API)
 *
 * WO-0594 AC1+AC2: Added post-push verification via sandbox_exec cat and wc -c.
 */
export async function handleGithubPushFiles(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { message, branch } = input;
  const repo = input.repo || "olivergale/metis-portal2";
  const files = input.files;

  if (!files || !Array.isArray(files) || files.length === 0) {
    return { success: false, error: "Missing required parameter: files (array of {path, content} or {path, patches})" };
  }
  if (!message) {
    return { success: false, error: "Missing required parameter: message (commit message)" };
  }

  const token = ctx.githubToken || (await getGitHubToken(ctx.supabase));
  if (!token) {
    return { success: false, error: "GitHub token not available" };
  }

  const ref = branch || "main";
  const hdrs = githubHeaders(token);

  try {
    // Step 1: GET ref -> base commit SHA
    const refResp = await fetch(`${GITHUB_API}/repos/${repo}/git/ref/heads/${ref}`, { headers: hdrs });
    if (!refResp.ok) {
      return { success: false, error: `Cannot find branch '${ref}': ${refResp.status}` };
    }
    const baseCommitSha = (await refResp.json()).object.sha;

    // Step 2: GET commit -> base tree SHA
    const commitResp = await fetch(`${GITHUB_API}/repos/${repo}/git/commits/${baseCommitSha}`, { headers: hdrs });
    if (!commitResp.ok) {
      return { success: false, error: `Cannot get commit: ${commitResp.status}` };
    }
    const baseTreeSha = (await commitResp.json()).tree.sha;

    // Step 2.5 (WO guardrail-file-size-validation): Pre-commit file size validation
    // Reject pushes where any file shrinks by more than 50% to prevent truncation
    for (const file of files) {
      if (!file.path || !file.content) continue; // skip patch-mode and missing paths
      const newSizeBytes = new TextEncoder().encode(file.content).length;
      // Check current file size on branch via Contents API (HEAD only, no body download needed)
      try {
        const sizeCheckResp = await fetch(
          `${GITHUB_API}/repos/${repo}/contents/${file.path}?ref=${ref}`,
          { method: "HEAD", headers: hdrs }
        );
        if (sizeCheckResp.ok) {
          // HEAD doesn't return JSON, use GET with size-only
          const sizeGetResp = await fetch(
            `${GITHUB_API}/repos/${repo}/contents/${file.path}?ref=${ref}`,
            { headers: hdrs }
          );
          if (sizeGetResp.ok) {
            const fileInfo = await sizeGetResp.json();
            const currentSize = fileInfo.size || 0;
            if (currentSize > 0 && newSizeBytes < currentSize * 0.5) {
              const pctReduction = Math.round((1 - newSizeBytes / currentSize) * 100);
              const errorMsg = `File ${file.path} would shrink from ${currentSize} to ${newSizeBytes} bytes (${pctReduction}% reduction). This looks like truncation. Aborting push.`;
              // Log the rejection as a failed mutation
              try {
                await ctx.supabase.rpc("record_mutation", {
                  p_work_order_id: ctx.workOrderId,
                  p_tool_name: "github_push_files",
                  p_object_type: "file",
                  p_object_id: file.path,
                  p_action: "PUSH",
                  p_success: false,
                  p_error_class: "FILE_SIZE_VALIDATION",
                  p_error_detail: `Truncation guard: current=${currentSize}B, new=${newSizeBytes}B, reduction=${pctReduction}%`,
                  p_context: { current_size: currentSize, new_size: newSizeBytes, pct_reduction: pctReduction, branch: ref },
                  p_agent_name: ctx.agentName || "builder",
                });
              } catch (_mutErr) { /* non-fatal logging */ }
              return { success: false, error: errorMsg };
            }
          }
        }
        // If 404 (new file) or error, skip size check — that's fine
      } catch (_sizeErr) {
        // Network error checking size — allow push to proceed
      }
    }

    // Step 3: Create blobs for each file
    const treeItems: Array<{ path: string; mode: string; type: string; sha: string }> = [];
    const processedFiles: string[] = [];

    for (const file of files) {
      if (!file.path) {
        return { success: false, error: "Each file must have a 'path' property" };
      }

      let fileContent: string;

      if (file.content !== undefined) {
        // Full content mode
        fileContent = file.content;
      } else if (file.patches && Array.isArray(file.patches)) {
        // Patch mode: read current file as raw text (no base64 decode)
        const rawResp = await fetch(
          `${GITHUB_API}/repos/${repo}/contents/${file.path}?ref=${ref}`,
          { headers: { ...hdrs, Accept: "application/vnd.github.raw+json" } }
        );
        if (!rawResp.ok) {
          return { success: false, error: `Cannot read ${file.path} for patching: ${rawResp.status}` };
        }
        fileContent = await rawResp.text();

        // Apply patches sequentially
        for (let i = 0; i < file.patches.length; i++) {
          const patch = file.patches[i];
          if (!patch.search || patch.replace === undefined) {
            return { success: false, error: `File ${file.path} patch ${i}: missing 'search' or 'replace'` };
          }
          if (fileContent.indexOf(patch.search) === -1) {
            return { success: false, error: `File ${file.path} patch ${i}: search string not found. First 80 chars: "${patch.search.slice(0, 80)}"` };
          }
          fileContent = fileContent.replace(patch.search, patch.replace);
        }
      } else {
        return { success: false, error: `File ${file.path}: must provide either 'content' or 'patches'` };
      }

      // Create blob via Git Data API -- content sent as UTF-8, no base64
      const blobResp = await fetch(`${GITHUB_API}/repos/${repo}/git/blobs`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({ content: fileContent, encoding: "utf-8" }),
      });
      if (!blobResp.ok) {
        const errText = await blobResp.text();
        return { success: false, error: `Failed to create blob for ${file.path}: ${blobResp.status} ${errText}` };
      }
      treeItems.push({
        path: file.path,
        mode: "100644",
        type: "blob",
        sha: (await blobResp.json()).sha,
      });
      processedFiles.push(file.path);
    }

    // Step 4: Create tree with base_tree
    const treeResp = await fetch(`${GITHUB_API}/repos/${repo}/git/trees`, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems }),
    });
    if (!treeResp.ok) {
      const errText = await treeResp.text();
      return { success: false, error: `Failed to create tree: ${treeResp.status} ${errText}` };
    }
    const newTreeSha = (await treeResp.json()).sha;

    // Step 5: Create commit
    const newCommitResp = await fetch(`${GITHUB_API}/repos/${repo}/git/commits`, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify({ message, tree: newTreeSha, parents: [baseCommitSha] }),
    });
    if (!newCommitResp.ok) {
      const errText = await newCommitResp.text();
      return { success: false, error: `Failed to create commit: ${newCommitResp.status} ${errText}` };
    }
    const newCommitSha = (await newCommitResp.json()).sha;

    // Step 6: Update ref (fast-forward)
    const updateRefResp = await fetch(`${GITHUB_API}/repos/${repo}/git/refs/heads/${ref}`, {
      method: "PATCH",
      headers: hdrs,
      body: JSON.stringify({ sha: newCommitSha }),
    });
    if (!updateRefResp.ok) {
      const errText = await updateRefResp.text();
      return { success: false, error: `Failed to update ref: ${updateRefResp.status} ${errText}` };
    }

    // WO-0594 AC1+AC2: Verify pushed files via sandbox_exec
    const verificationResults: Array<{path: string; verified: boolean; actualBytes: number; expectedBytes: number; error?: string}> = [];
    for (const file of files) {
      if (!file.path) continue;
      
      // Get expected byte count from content/patches
      let expectedBytes = 0;
      if (file.content) {
        expectedBytes = new TextEncoder().encode(file.content).length;
      } else if (file.patches) {
        // For patches, we can't easily calculate expected bytes - skip verification
        continue;
      }

      // Call sandbox_exec to verify byte count
      const verification = await verifyPushedFile(ctx, file.path, expectedBytes);
      verificationResults.push({
        path: file.path,
        verified: verification.verified,
        actualBytes: verification.actualBytes,
        expectedBytes,
        error: verification.error,
      });

      // Log verification result via recordMutation with verified flag
      await recordVerification(
        ctx.supabase,
        ctx.workOrderId,
        "github_push_files",
        file.path,
        verification.verified,
        {
          actual_bytes: verification.actualBytes,
          expected_bytes: expectedBytes,
          mismatch_percent: expectedBytes > 0 ? Math.abs(verification.actualBytes - expectedBytes) / expectedBytes * 100 : 0,
          error: verification.error,
        }
      );

      // AC2: Log warning if mismatch > 5%
      const mismatchPercent = expectedBytes > 0 
        ? Math.abs(verification.actualBytes - expectedBytes) / expectedBytes * 100 
        : 0;
      if (mismatchPercent > 5 && !verification.error) {
        await ctx.supabase.from("work_order_execution_log").insert({
          work_order_id: ctx.workOrderId,
          phase: "stream",
          agent_name: ctx.agentName,
          detail: {
            event_type: "byte_count_mismatch_warning",
            tool_name: "github_push_files",
            file_path: file.path,
            actual_bytes: verification.actualBytes,
            expected_bytes: expectedBytes,
            mismatch_percent: mismatchPercent.toFixed(2),
            message: `WARNING: File byte count differs by ${mismatchPercent.toFixed(1)}% from expected`,
          },
        });
      }
    }

    // Build verification summary for result message
    const verifiedCount = verificationResults.filter(v => v.verified).length;
    const totalVerified = verificationResults.length;
    let verificationMessage = "";
    if (totalVerified > 0) {
      verificationMessage = ` (verified ${verifiedCount}/${totalVerified} files)`;
    }

    return {
      success: true,
      data: {
        commit_sha: newCommitSha,
        tree_sha: newTreeSha,
        files_committed: processedFiles,
        file_count: processedFiles.length,
        verification: verificationResults,
        message: `Committed ${processedFiles.length} file(s) to ${repo}/${ref}: ${processedFiles.join(", ")}${verificationMessage}`,
      },
    };
  } catch (e: any) {
    return { success: false, error: `github_push_files exception: ${e.message}` };
  }
}

/**
 * WO-0564: Read full file content using Git Data API (no 10k truncation).
 * Uses /git/trees to find blob SHA, then /git/blobs/:sha for full base64 content.
 * Supports files up to 100MB (GitHub blob API limit).
 */
export async function handleReadFullFile(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { path, ref: inputRef } = input;
  const repo = input.repo || "olivergale/metis-portal2";

  if (!path) {
    return { success: false, error: "Missing required parameter: path" };
  }

  const token = ctx.githubToken || (await getGitHubToken(ctx.supabase));
  if (!token) {
    return { success: false, error: "GitHub token not available" };
  }

  try {
    const ref = inputRef || "main";
    const hdrs = githubHeaders(token);

    // Step 1: Get the tree SHA for the branch
    const refResp = await fetch(
      `${GITHUB_API}/repos/${repo}/git/ref/heads/${ref}`,
      { headers: hdrs }
    );
    if (!refResp.ok) {
      return { success: false, error: `Cannot find branch '${ref}': ${refResp.status}` };
    }
    const commitSha = (await refResp.json()).object.sha;

    // Step 2: Get recursive tree to find the blob SHA for the target path
    const treeResp = await fetch(
      `${GITHUB_API}/repos/${repo}/git/trees/${commitSha}?recursive=1`,
      { headers: hdrs }
    );
    if (!treeResp.ok) {
      return { success: false, error: `Cannot get tree: ${treeResp.status}` };
    }
    const treeData = await treeResp.json();
    const entry = (treeData.tree || []).find((item: any) => item.path === path && item.type === "blob");
    if (!entry) {
      return { success: false, error: `File not found in tree: ${path} (branch: ${ref})` };
    }

    // Step 3: Get blob content via Git Data API (full content, no truncation)
    const blobResp = await fetch(
      `${GITHUB_API}/repos/${repo}/git/blobs/${entry.sha}`,
      { headers: hdrs }
    );
    if (!blobResp.ok) {
      return { success: false, error: `Cannot get blob: ${blobResp.status}` };
    }
    const blobData = await blobResp.json();

    // Decode base64 content
    const content = atob(blobData.content.replace(/\n/g, ""));
    const lines = content.split("\n");

    return {
      success: true,
      data: {
        content,
        path,
        repo,
        branch: ref,
        sha: entry.sha,
        size: blobData.size,
        line_count: lines.length,
        char_count: content.length,
        encoding: blobData.encoding,
      },
    };
  } catch (e: any) {
    return { success: false, error: `read_full_file exception: ${e.message}` };
  }
}

/**
 * WO-0566: Get commit history for a file or repo using GitHub Commits API.
 */
export async function handleGitLog(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { path, ref: inputRef, limit } = input;
  const repo = input.repo || "olivergale/metis-portal2";

  const token = ctx.githubToken || (await getGitHubToken(ctx.supabase));
  if (!token) {
    return { success: false, error: "GitHub token not available" };
  }

  try {
    const params = new URLSearchParams();
    params.set("per_page", String(Math.min(limit || 20, 100)));
    if (inputRef) params.set("sha", inputRef);
    if (path) params.set("path", path);

    const resp = await fetch(
      `${GITHUB_API}/repos/${repo}/commits?${params.toString()}`,
      { headers: githubHeaders(token) }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      return { success: false, error: `GitHub Commits API error ${resp.status}: ${errText}` };
    }

    const commits = await resp.json();
    const results = commits.map((c: any) => ({
      sha: c.sha,
      message: c.commit.message,
      author: c.commit.author?.name || c.author?.login || "unknown",
      date: c.commit.author?.date,
      url: c.html_url,
    }));

    return {
      success: true,
      data: {
        commits: results,
        count: results.length,
        path: path || "(all files)",
        repo,
        ref: inputRef || "main",
      },
    };
  } catch (e: any) {
    return { success: false, error: `git_log exception: ${e.message}` };
  }
}

/**
 * WO-0566: Compare two commits/branches using GitHub Compare API.
 */
export async function handleGitDiff(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { base, head } = input;
  const repo = input.repo || "olivergale/metis-portal2";

  if (!base) {
    return { success: false, error: "Missing required parameter: base (commit SHA or branch name)" };
  }

  const token = ctx.githubToken || (await getGitHubToken(ctx.supabase));
  if (!token) {
    return { success: false, error: "GitHub token not available" };
  }

  try {
    const headRef = head || "main";
    const resp = await fetch(
      `${GITHUB_API}/repos/${repo}/compare/${base}...${headRef}`,
      { headers: githubHeaders(token) }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      return { success: false, error: `GitHub Compare API error ${resp.status}: ${errText}` };
    }

    const data = await resp.json();
    const files = (data.files || []).map((f: any) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      patch: (f.patch || "").substring(0, 5000),
    }));

    return {
      success: true,
      data: {
        base,
        head: headRef,
        repo,
        status: data.status,
        ahead_by: data.ahead_by,
        behind_by: data.behind_by,
        total_commits: data.total_commits,
        files,
        file_count: files.length,
      },
    };
  } catch (e: any) {
    return { success: false, error: `git_diff exception: ${e.message}` };
  }
}

/**
 * WO-0566: Get line-level blame using GitHub REST API.
 * Note: GitHub REST doesn't have a direct blame endpoint, but we can get
 * commit history per line range via the commits API. For full blame,
 * we use the community endpoint that returns blame data.
 */
export async function handleGitBlame(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { path, ref: inputRef } = input;
  const repo = input.repo || "olivergale/metis-portal2";

  if (!path) {
    return { success: false, error: "Missing required parameter: path" };
  }

  const token = ctx.githubToken || (await getGitHubToken(ctx.supabase));
  if (!token) {
    return { success: false, error: "GitHub token not available" };
  }

  try {
    const ref = inputRef || "main";

    // Use GitHub GraphQL API for blame data
    const query = `
      query($owner: String!, $name: String!, $ref: String!, $path: String!) {
        repository(owner: $owner, name: $name) {
          object(expression: $ref) {
            ... on Commit {
              blame(path: $path) {
                ranges {
                  startingLine
                  endingLine
                  commit {
                    oid
                    message
                    author {
                      name
                      date
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const [owner, name] = repo.split("/");
    const resp = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        query,
        variables: { owner, name, ref, path },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return { success: false, error: `GitHub GraphQL API error ${resp.status}: ${errText}` };
    }

    const gqlData = await resp.json();
    if (gqlData.errors) {
      return { success: false, error: `GraphQL errors: ${JSON.stringify(gqlData.errors)}` };
    }

    const blame = gqlData.data?.repository?.object?.blame;
    if (!blame) {
      return { success: false, error: `No blame data found for ${path} at ${ref}` };
    }

    const ranges = (blame.ranges || []).map((r: any) => ({
      startLine: r.startingLine,
      endLine: r.endingLine,
      commit_sha: r.commit.oid.substring(0, 10),
      commit_message: r.commit.message.split("\n")[0].substring(0, 80),
      author: r.commit.author?.name || "unknown",
      date: r.commit.author?.date,
    }));

    return {
      success: true,
      data: {
        path,
        repo,
        ref,
        ranges,
        range_count: ranges.length,
      },
    };
  } catch (e: any) {
    return { success: false, error: `git_blame exception: ${e.message}` };
  }
}

export async function handleGithubTree(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { path_filter, branch, show_sizes } = input;
  const repo = input.repo || "olivergale/metis-portal2";

  const token = ctx.githubToken || (await getGitHubToken(ctx.supabase));
  if (!token) {
    return { success: false, error: "GitHub token not available" };
  }

  try {
    const ref = branch || "main";
    
    // Get the SHA for the branch
    const refResp = await fetch(
      `${GITHUB_API}/repos/${repo}/git/ref/heads/${ref}`,
      { headers: githubHeaders(token) }
    );

    if (!refResp.ok) {
      const errText = await refResp.text();
      return { success: false, error: `Cannot find branch '${ref}': ${refResp.status} ${errText}` };
    }

    const refData = await refResp.json();
    const sha = refData.object.sha;

    // Get the tree recursively
    const treeResp = await fetch(
      `${GITHUB_API}/repos/${repo}/git/trees/${sha}?recursive=true`,
      { headers: githubHeaders(token) }
    );

    if (!treeResp.ok) {
      const errText = await treeResp.text();
      return { success: false, error: `GitHub tree API error ${treeResp.status}: ${errText}` };
    }

    const treeData = await treeResp.json();
    let items = treeData.tree || [];

    // Filter by path_filter if provided
    if (path_filter) {
      items = items.filter((item: any) => item.path.startsWith(path_filter));
    }

    // Limit to 500 entries
    const totalCount = items.length;
    const omittedCount = Math.max(0, totalCount - 500);
    items = items.slice(0, 500);

    // Build tree structure with indentation
    const tree: string[] = [];
    items.forEach((item: any) => {
      const depth = item.path.split("/").length - 1;
      const indent = "  ".repeat(depth);
      const name = item.path.split("/").pop();
      const type = item.type === "tree" ? " -- " : " -- ";
      const sizeInfo = show_sizes && item.size ? ` (${item.size} bytes)` : "";
      tree.push(`${indent}${type} ${name}${sizeInfo}`);
    });

    const treeString = tree.join("\n");

    return {
      success: true,
      data: {
        repo,
        branch: ref,
        path_filter: path_filter || "(all paths)",
        total_count: totalCount,
        showing_count: items.length,
        omitted_count: omittedCount,
        tree: treeString,
        message: omittedCount > 0
          ? `Showing ${items.length} of ${totalCount} entries (${omittedCount} omitted)`
          : `Showing all ${items.length} entries`,
      },
    };
  } catch (e: any) {
    return { success: false, error: `github_tree exception: ${e.message}` };
  }
}
