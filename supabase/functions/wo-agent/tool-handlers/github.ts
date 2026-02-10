// wo-agent/tool-handlers/github.ts
// GitHub tools: read_file, write_file, list_files, create_branch, create_pr

import type { ToolContext, ToolResult } from "../tools.ts";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "Endgame-WO-Agent";

/**
 * Log error to error_events table for centralized error tracking
 * WO-0266: Silent failure detection
 */
async function logError(
  ctx: ToolContext,
  severity: string,
  sourceFunction: string,
  errorCode: string,
  message: string,
  context: Record<string, any> = {}
): Promise<void> {
  try {
    await ctx.supabase.rpc("log_error_event", {
      p_severity: severity,
      p_source_function: sourceFunction,
      p_error_code: errorCode,
      p_message: message,
      p_context: context,
      p_work_order_id: ctx.workOrderId,
      p_agent_id: null,
    });
  } catch (e: any) {
    // Silent failure in error logging - don't cascade
    console.error(`[ERROR_LOG] Failed to log error: ${e.message}`);
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
      const errorMsg = `File not found: ${repo}/${path} (branch: ${ref})`;
      await logError(ctx, "warning", "wo-agent/github_read_file", "FILE_NOT_FOUND", errorMsg, { repo, path, branch: ref });
      return { success: false, error: errorMsg };
    }
    if (!resp.ok) {
      const errText = await resp.text();
      const errorMsg = `GitHub API error ${resp.status}: ${errText}`;
      await logError(ctx, "error", "wo-agent/github_read_file", "GITHUB_API_ERROR", errorMsg, { repo, path, branch: ref, status: resp.status });
      return { success: false, error: errorMsg };
    }

    const data = await resp.json();
    // Decode base64 content
    const content = atob(data.content.replace(/\n/g, ""));
    // Limit output size
    const limited = content.length > 10000 ? content.slice(0, 10000) + "\n...(limited to 10000 chars)" : content;

    return {
      success: true,
      data: { content: limited, sha: data.sha, size: data.size, path: data.path },
    };
  } catch (e: any) {
    const errorMsg = `github_read_file exception: ${e.message}`;
    await logError(ctx, "error", "wo-agent/github_read_file", "EXCEPTION", errorMsg, { repo, path });
    return { success: false, error: errorMsg };
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
      const errorMsg = `GitHub write error ${resp.status}: ${errText}`;
      await logError(ctx, "error", "wo-agent/github_write_file", "WRITE_FAILED", errorMsg, { repo, path, status: resp.status });
      return { success: false, error: errorMsg };
    }

    const result = await resp.json();
    return {
      success: true,
      data: {
        commit_sha: result.commit?.sha,
        html_url: result.content?.html_url,
        message: `Wrote ${path} to ${repo}`,
      },
    };
  } catch (e: any) {
    return { success: false, error: `github_write_file exception: ${e.message}` };
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

    if (resp.status === 404) {
      return { success: false, error: `Path not found: ${repo}/${dirPath} (branch: ${ref})` };
    }
    if (!resp.ok) {
      const errText = await resp.text();
      return { success: false, error: `GitHub API error ${resp.status}: ${errText}` };
    }

    const data = await resp.json();
    
    // Handle both file and directory responses
    if (Array.isArray(data)) {
      // Directory listing
      const items = data.map((item: any) => ({
        name: item.name,
        path: item.path,
        type: item.type,
        size: item.size,
        sha: item.sha,
      }));
      return { success: true, data: { items, count: items.length, path: dirPath } };
    } else {
      // Single file
      return { success: true, data: { items: [{ name: data.name, path: data.path, type: data.type, size: data.size, sha: data.sha }], count: 1, path: dirPath } };
    }
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
    const baseBranch = from_branch || "main";

    // Get the SHA of the base branch
    const refResp = await fetch(
      `${GITHUB_API}/repos/${repo}/git/ref/heads/${baseBranch}`,
      { headers: githubHeaders(token) }
    );

    if (!refResp.ok) {
      const errText = await refResp.text();
      return { success: false, error: `Failed to get base branch SHA: ${errText}` };
    }

    const refData = await refResp.json();
    const sha = refData.object.sha;

    // Create the new branch
    const createResp = await fetch(
      `${GITHUB_API}/repos/${repo}/git/refs`,
      {
        method: "POST",
        headers: githubHeaders(token),
        body: JSON.stringify({
          ref: `refs/heads/${branch}`,
          sha: sha,
        }),
      }
    );

    if (!createResp.ok) {
      const errText = await createResp.text();
      return { success: false, error: `Failed to create branch: ${errText}` };
    }

    const result = await createResp.json();
    return {
      success: true,
      data: {
        branch: branch,
        sha: result.object.sha,
        from_branch: baseBranch,
        message: `Created branch ${branch} from ${baseBranch}`,
      },
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
    const baseBranch = base || "main";

    const resp = await fetch(
      `${GITHUB_API}/repos/${repo}/pulls`,
      {
        method: "POST",
        headers: githubHeaders(token),
        body: JSON.stringify({
          title: title,
          head: head,
          base: baseBranch,
          body: body || "",
        }),
      }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      return { success: false, error: `Failed to create PR: ${errText}` };
    }

    const result = await resp.json();
    return {
      success: true,
      data: {
        pr_number: result.number,
        html_url: result.html_url,
        state: result.state,
        title: result.title,
        message: `Created PR #${result.number}: ${title}`,
      },
    };
  } catch (e: any) {
    return { success: false, error: `github_create_pr exception: ${e.message}` };
  }
}
