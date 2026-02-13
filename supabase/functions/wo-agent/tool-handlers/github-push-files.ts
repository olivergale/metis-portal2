// wo-agent/tool-handlers/github-push-files.ts
// WO-0533: Atomic multi-file commit using Git Data API

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
 * WO-0533: Atomic multi-file commit using Git Data API
 * Eliminates clobber risk from sequential single-file commits
 */
export async function handleGithubPushFiles(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { files, commit_message, branch } = input;
  const repo = input.repo || "olivergale/metis-portal2";

  // Validation
  if (!files || !Array.isArray(files) || files.length === 0) {
    return { success: false, error: "Missing required parameter: files (array of {path, content})" };
  }
  if (!commit_message) {
    return { success: false, error: "Missing required parameter: commit_message" };
  }
  if (files.length > 20) {
    return { success: false, error: "Maximum 20 files per commit (current: " + files.length + ")" };
  }

  // Validate each file has path and content
  for (let i = 0; i < files.length; i++) {
    if (!files[i].path || files[i].content === undefined) {
      return { success: false, error: `File ${i}: missing 'path' or 'content' field` };
    }
  }

  const token = ctx.githubToken || (await getGitHubToken(ctx.supabase));
  if (!token) {
    return { success: false, error: "GitHub token not available" };
  }

  try {
    const ref = branch || "main";

    // Step (a): GET /repos/{repo}/git/ref/heads/{branch} to get current HEAD SHA
    const refResp = await fetch(
      `${GITHUB_API}/repos/${repo}/git/ref/heads/${ref}`,
      { headers: githubHeaders(token) }
    );

    if (!refResp.ok) {
      const errText = await refResp.text();
      return { success: false, error: `Cannot find branch '${ref}': ${refResp.status} ${errText}` };
    }

    const refData = await refResp.json();
    const headSha = refData.object.sha;

    // Step (b): GET /repos/{repo}/git/commits/{sha} to get base tree SHA
    const commitResp = await fetch(
      `${GITHUB_API}/repos/${repo}/git/commits/${headSha}`,
      { headers: githubHeaders(token) }
    );

    if (!commitResp.ok) {
      const errText = await commitResp.text();
      return { success: false, error: `Cannot get commit ${headSha}: ${commitResp.status} ${errText}` };
    }

    const commitData = await commitResp.json();
    const baseTreeSha = commitData.tree.sha;

    // Step (c): POST /repos/{repo}/git/blobs for each file to create blob with content and encoding utf-8
    const blobShas: string[] = [];
    for (const file of files) {
      const blobResp = await fetch(
        `${GITHUB_API}/repos/${repo}/git/blobs`,
        {
          method: "POST",
          headers: githubHeaders(token),
          body: JSON.stringify({
            content: file.content,
            encoding: "utf-8",
          }),
        }
      );

      if (!blobResp.ok) {
        const errText = await blobResp.text();
        return {
          success: false,
          error: `Failed to create blob for ${file.path}: ${blobResp.status} ${errText}. Aborted before creating tree (no partial commit).`,
        };
      }

      const blobData = await blobResp.json();
      blobShas.push(blobData.sha);
    }

    // Step (d): POST /repos/{repo}/git/trees with base_tree and array of tree entries
    const treeEntries = files.map((file, i) => ({
      path: file.path,
      mode: "100644",
      type: "blob",
      sha: blobShas[i],
    }));

    const treeResp = await fetch(
      `${GITHUB_API}/repos/${repo}/git/trees`,
      {
        method: "POST",
        headers: githubHeaders(token),
        body: JSON.stringify({
          base_tree: baseTreeSha,
          tree: treeEntries,
        }),
      }
    );

    if (!treeResp.ok) {
      const errText = await treeResp.text();
      return { success: false, error: `Failed to create tree: ${treeResp.status} ${errText}` };
    }

    const treeData = await treeResp.json();
    const newTreeSha = treeData.sha;

    // Step (e): POST /repos/{repo}/git/commits with message, tree SHA, parents array with HEAD SHA
    const newCommitResp = await fetch(
      `${GITHUB_API}/repos/${repo}/git/commits`,
      {
        method: "POST",
        headers: githubHeaders(token),
        body: JSON.stringify({
          message: commit_message,
          tree: newTreeSha,
          parents: [headSha],
        }),
      }
    );

    if (!newCommitResp.ok) {
      const errText = await newCommitResp.text();
      return { success: false, error: `Failed to create commit: ${newCommitResp.status} ${errText}` };
    }

    const newCommitData = await newCommitResp.json();
    const newCommitSha = newCommitData.sha;

    // Step (f): PATCH /repos/{repo}/git/refs/heads/{branch} with new commit SHA
    const updateRefResp = await fetch(
      `${GITHUB_API}/repos/${repo}/git/refs/heads/${ref}`,
      {
        method: "PATCH",
        headers: githubHeaders(token),
        body: JSON.stringify({
          sha: newCommitSha,
          force: false, // Reject if HEAD has changed (race condition)
        }),
      }
    );

    if (!updateRefResp.ok) {
      const errText = await updateRefResp.text();
      return {
        success: false,
        error: `Failed to update ref (race condition - branch HEAD changed during commit): ${updateRefResp.status} ${errText}. Suggest retry.`,
      };
    }

    // Success!
    const filePaths = files.map((f) => f.path);
    return {
      success: true,
      data: {
        commit_sha: newCommitSha,
        files_committed: files.length,
        commit_url: `https://github.com/${repo}/commit/${newCommitSha}`,
        file_paths: filePaths,
        message: `Committed ${files.length} files atomically: ${filePaths.join(", ")}`,
      },
    };
  } catch (e: any) {
    return { success: false, error: `github_push_files exception: ${e.message}` };
  }
}
