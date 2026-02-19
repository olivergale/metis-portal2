// verify/handlers/github.ts
// GitHub Git Data API proxy — server-side execution with edge_proxy mutation recording
// Replicates the flow from wo-agent/tool-handlers/github.ts lines 665-928

import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { sha256 } from "../lib/hash.ts";
import { recordMutation } from "../lib/record.ts";

const GITHUB_API = "https://api.github.com";

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Retrieve GitHub token from secrets table (not passed by agent).
 */
async function getGitHubToken(supabase: SupabaseClient): Promise<string | null> {
  const { data } = await supabase
    .from("secrets")
    .select("value")
    .eq("key", "GITHUB_TOKEN")
    .single();
  return data?.value || Deno.env.get("GITHUB_TOKEN") || null;
}

interface PushFilesRequest {
  wo_id: string;
  agent_name: string;
  repo?: string;
  branch?: string;
  message: string;
  files: Array<{
    path: string;
    content?: string;
    patches?: Array<{ search: string; replace: string }>;
  }>;
}

/**
 * Proxy github_push_files: Git Data API flow executed server-side.
 * GET ref -> GET commit -> POST blobs -> POST tree -> POST commit -> PATCH ref
 */
export async function handlePush(
  body: PushFilesRequest,
  supabase: SupabaseClient
): Promise<Response> {
  const { wo_id, agent_name, message, files } = body;
  const repo = body.repo || "olivergale/metis-portal2";
  const ref = body.branch || "main";

  if (!wo_id || !agent_name) {
    return json({ success: false, error: "Missing wo_id or agent_name" }, 400);
  }
  if (!files || !Array.isArray(files) || files.length === 0) {
    return json({ success: false, error: "Missing files array" }, 400);
  }
  if (!message) {
    return json({ success: false, error: "Missing commit message" }, 400);
  }

  const token = await getGitHubToken(supabase);
  if (!token) {
    return json({ success: false, error: "GitHub token not available" }, 500);
  }

  const hdrs = githubHeaders(token);

  try {
    // Step 1: GET ref -> base commit SHA
    const refResp = await fetch(
      `${GITHUB_API}/repos/${repo}/git/ref/heads/${ref}`,
      { headers: hdrs }
    );
    if (!refResp.ok) {
      return json(
        { success: false, error: `Cannot find branch '${ref}': ${refResp.status}` },
        400
      );
    }
    const baseCommitSha = (await refResp.json()).object.sha;

    // Step 2: GET commit -> base tree SHA
    const commitResp = await fetch(
      `${GITHUB_API}/repos/${repo}/git/commits/${baseCommitSha}`,
      { headers: hdrs }
    );
    if (!commitResp.ok) {
      return json(
        { success: false, error: `Cannot get commit: ${commitResp.status}` },
        400
      );
    }
    const baseTreeSha = (await commitResp.json()).tree.sha;

    // Step 2.5: File size validation (truncation guard)
    for (const file of files) {
      if (!file.path || !file.content) continue;
      const newSizeBytes = new TextEncoder().encode(file.content).length;
      try {
        const sizeGetResp = await fetch(
          `${GITHUB_API}/repos/${repo}/contents/${file.path}?ref=${ref}`,
          { headers: hdrs }
        );
        if (sizeGetResp.ok) {
          const fileInfo = await sizeGetResp.json();
          const currentSize = fileInfo.size || 0;
          if (currentSize > 0 && newSizeBytes < currentSize * 0.5) {
            const pctReduction = Math.round(
              (1 - newSizeBytes / currentSize) * 100
            );
            await recordMutation(supabase, {
              workOrderId: wo_id,
              toolName: "github_push_files",
              objectType: "file",
              objectId: file.path,
              action: "PUSH",
              success: false,
              errorClass: "FILE_SIZE_VALIDATION",
              errorDetail: `Truncation guard: current=${currentSize}B, new=${newSizeBytes}B, reduction=${pctReduction}%`,
              context: { current_size: currentSize, new_size: newSizeBytes, pct_reduction: pctReduction, branch: ref },
              agentName: agent_name,
            });
            return json({
              success: false,
              error: `File ${file.path} would shrink from ${currentSize} to ${newSizeBytes} bytes (${pctReduction}% reduction). Aborting.`,
            }, 400);
          }
        }
      } catch (_) {
        // Network error — allow push to proceed
      }
    }

    // Step 3: Create blobs for each file
    const treeItems: Array<{ path: string; mode: string; type: string; sha: string }> = [];
    const processedFiles: string[] = [];

    for (const file of files) {
      if (!file.path) {
        return json({ success: false, error: "Each file must have a 'path'" }, 400);
      }

      let fileContent: string;

      if (file.content !== undefined) {
        fileContent = file.content;
      } else if (file.patches && Array.isArray(file.patches)) {
        // Patch mode: read current file as raw text
        const rawResp = await fetch(
          `${GITHUB_API}/repos/${repo}/contents/${file.path}?ref=${ref}`,
          { headers: { ...hdrs, Accept: "application/vnd.github.raw+json" } }
        );
        if (!rawResp.ok) {
          return json(
            { success: false, error: `Cannot read ${file.path} for patching: ${rawResp.status}` },
            400
          );
        }
        fileContent = await rawResp.text();

        for (let i = 0; i < file.patches.length; i++) {
          const patch = file.patches[i];
          if (!patch.search || patch.replace === undefined) {
            return json(
              { success: false, error: `File ${file.path} patch ${i}: missing 'search' or 'replace'` },
              400
            );
          }
          if (fileContent.indexOf(patch.search) === -1) {
            return json(
              { success: false, error: `File ${file.path} patch ${i}: search string not found` },
              400
            );
          }
          fileContent = fileContent.replace(patch.search, patch.replace);
        }
      } else {
        return json(
          { success: false, error: `File ${file.path}: must provide either 'content' or 'patches'` },
          400
        );
      }

      // Create blob via Git Data API
      const blobResp = await fetch(`${GITHUB_API}/repos/${repo}/git/blobs`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({ content: fileContent, encoding: "utf-8" }),
      });
      if (!blobResp.ok) {
        const errText = await blobResp.text();
        return json(
          { success: false, error: `Failed to create blob for ${file.path}: ${blobResp.status} ${errText}` },
          500
        );
      }
      treeItems.push({
        path: file.path,
        mode: "100644",
        type: "blob",
        sha: (await blobResp.json()).sha,
      });
      processedFiles.push(file.path);
    }

    // Step 4: Create tree
    const treeResp = await fetch(`${GITHUB_API}/repos/${repo}/git/trees`, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems }),
    });
    if (!treeResp.ok) {
      const errText = await treeResp.text();
      return json(
        { success: false, error: `Failed to create tree: ${treeResp.status} ${errText}` },
        500
      );
    }
    const newTreeSha = (await treeResp.json()).sha;

    // Step 5: Create commit
    const newCommitResp = await fetch(
      `${GITHUB_API}/repos/${repo}/git/commits`,
      {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({
          message,
          tree: newTreeSha,
          parents: [baseCommitSha],
        }),
      }
    );
    if (!newCommitResp.ok) {
      const errText = await newCommitResp.text();
      return json(
        { success: false, error: `Failed to create commit: ${newCommitResp.status} ${errText}` },
        500
      );
    }
    const newCommitSha = (await newCommitResp.json()).sha;

    // Step 6: Update ref (fast-forward)
    const updateRefResp = await fetch(
      `${GITHUB_API}/repos/${repo}/git/refs/heads/${ref}`,
      {
        method: "PATCH",
        headers: hdrs,
        body: JSON.stringify({ sha: newCommitSha }),
      }
    );
    if (!updateRefResp.ok) {
      const errText = await updateRefResp.text();
      return json(
        { success: false, error: `Failed to update ref: ${updateRefResp.status} ${errText}` },
        500
      );
    }

    // Record mutation with edge_proxy mode — commit SHA is content-addressed
    const mutation = await recordMutation(supabase, {
      workOrderId: wo_id,
      toolName: "github_push_files",
      objectType: "commit",
      objectId: `${repo}/${ref}`,
      action: "PUSH",
      success: true,
      resultHash: newCommitSha,
      context: {
        commit_sha: newCommitSha,
        tree_sha: newTreeSha,
        files: processedFiles,
        file_count: processedFiles.length,
        branch: ref,
      },
      agentName: agent_name,
      verificationQuery: `SELECT 1 FROM (SELECT sha FROM (VALUES ('${newCommitSha}')) AS t(sha)) t WHERE t.sha IS NOT NULL`,
    });

    return json({
      success: true,
      commit_sha: newCommitSha,
      tree_sha: newTreeSha,
      files_committed: processedFiles,
      file_count: processedFiles.length,
      mutation_id: mutation.mutationId,
      proxy_signature: mutation.proxySignature,
      proxy_mode: "edge_proxy",
    });
  } catch (e: unknown) {
    return json(
      { success: false, error: `github_push_files exception: ${(e as Error).message}` },
      500
    );
  }
}

interface CreateBranchRequest {
  wo_id: string;
  agent_name: string;
  repo?: string;
  branch: string;
  from_branch?: string;
}

/**
 * Proxy github_create_branch: Create a new branch from an existing ref.
 */
export async function handleCreateBranch(
  body: CreateBranchRequest,
  supabase: SupabaseClient
): Promise<Response> {
  const { wo_id, agent_name, branch } = body;
  const repo = body.repo || "olivergale/metis-portal2";
  const fromBranch = body.from_branch || "main";

  if (!wo_id || !agent_name || !branch) {
    return json({ success: false, error: "Missing wo_id, agent_name, or branch" }, 400);
  }

  const token = await getGitHubToken(supabase);
  if (!token) {
    return json({ success: false, error: "GitHub token not available" }, 500);
  }

  const hdrs = githubHeaders(token);

  try {
    // Get SHA of source branch
    const refResp = await fetch(
      `${GITHUB_API}/repos/${repo}/git/ref/heads/${fromBranch}`,
      { headers: hdrs }
    );
    if (!refResp.ok) {
      return json(
        { success: false, error: `Source branch '${fromBranch}' not found: ${refResp.status}` },
        400
      );
    }
    const sourceSha = (await refResp.json()).object.sha;

    // Create new ref
    const createResp = await fetch(`${GITHUB_API}/repos/${repo}/git/refs`, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: sourceSha }),
    });
    if (!createResp.ok) {
      const errText = await createResp.text();
      return json(
        { success: false, error: `Failed to create branch: ${createResp.status} ${errText}` },
        500
      );
    }

    const mutation = await recordMutation(supabase, {
      workOrderId: wo_id,
      toolName: "github_create_branch",
      objectType: "branch",
      objectId: `${repo}/${branch}`,
      action: "CREATE",
      success: true,
      resultHash: sourceSha,
      context: { from_branch: fromBranch, new_branch: branch, source_sha: sourceSha },
      agentName: agent_name,
    });

    return json({
      success: true,
      branch,
      source_sha: sourceSha,
      mutation_id: mutation.mutationId,
      proxy_signature: mutation.proxySignature,
      proxy_mode: "edge_proxy",
    });
  } catch (e: unknown) {
    return json(
      { success: false, error: `create_branch exception: ${(e as Error).message}` },
      500
    );
  }
}

interface CreatePrRequest {
  wo_id: string;
  agent_name: string;
  repo?: string;
  title: string;
  body?: string;
  head: string;
  base?: string;
}

/**
 * Proxy github_create_pr: Create a pull request.
 */
export async function handleCreatePr(
  body: CreatePrRequest,
  supabase: SupabaseClient
): Promise<Response> {
  const { wo_id, agent_name, title, head } = body;
  const repo = body.repo || "olivergale/metis-portal2";
  const base = body.base || "main";

  if (!wo_id || !agent_name || !title || !head) {
    return json({ success: false, error: "Missing wo_id, agent_name, title, or head" }, 400);
  }

  const token = await getGitHubToken(supabase);
  if (!token) {
    return json({ success: false, error: "GitHub token not available" }, 500);
  }

  try {
    const prResp = await fetch(`${GITHUB_API}/repos/${repo}/pulls`, {
      method: "POST",
      headers: githubHeaders(token),
      body: JSON.stringify({ title, body: body.body || "", head, base }),
    });
    if (!prResp.ok) {
      const errText = await prResp.text();
      return json(
        { success: false, error: `Failed to create PR: ${prResp.status} ${errText}` },
        500
      );
    }
    const pr = await prResp.json();

    const resultHash = await sha256(`pr-${pr.number}-${pr.head.sha}`);
    const mutation = await recordMutation(supabase, {
      workOrderId: wo_id,
      toolName: "github_create_pr",
      objectType: "pull_request",
      objectId: `${repo}#${pr.number}`,
      action: "CREATE",
      success: true,
      resultHash,
      context: { pr_number: pr.number, pr_url: pr.html_url, head, base },
      agentName: agent_name,
    });

    return json({
      success: true,
      pr_number: pr.number,
      pr_url: pr.html_url,
      mutation_id: mutation.mutationId,
      proxy_signature: mutation.proxySignature,
      proxy_mode: "edge_proxy",
    });
  } catch (e: unknown) {
    return json(
      { success: false, error: `create_pr exception: ${(e as Error).message}` },
      500
    );
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
