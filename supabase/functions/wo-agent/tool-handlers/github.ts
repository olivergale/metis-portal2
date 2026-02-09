// wo-agent/tool-handlers/github.ts
// GitHub tools: read_file, write_file

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
    const content = atob(data.content.replace(/\n/g, ""));
    // Limit output size
    const limited = content.length > 10000 ? content.slice(0, 10000) + "\n...(limited to 10000 chars)" : content;

    return {
      success: true,
      data: { content: limited, sha: data.sha, size: data.size, path: data.path },
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
      return { success: false, error: `GitHub write error ${resp.status}: ${errText}` };
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
