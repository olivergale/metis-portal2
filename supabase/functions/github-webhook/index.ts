// github-webhook/index.ts v2
// GitHub App webhook handler for issue + push events
// - issues.labeled with 'endgame'/'wo-create' → auto-create WO via create_draft_work_order() RPC
// - push events → index file changes into github_file_index for verification coverage

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-hub-signature-256, x-github-event, x-github-delivery",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// GitHub webhook secret for signature verification
const WEBHOOK_SECRET = Deno.env.get("GITHUB_WEBHOOK_SECRET");

// Labels that trigger WO creation
const TRIGGER_LABELS = ["endgame", "wo-create"];

// Priority mapping from GitHub labels
const PRIORITY_MAP: Record<string, string> = {
  "priority:p0": "p0_critical",
  "priority:p1": "p1_high",
  "priority:p2": "p2_medium",
  "priority:p3": "p3_low",
};

interface GitHubIssueEvent {
  action: string;
  issue: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    labels: Array<{ name: string }>;
    user: {
      login: string;
    };
  };
  label?: {
    name: string;
  };
  repository: {
    full_name: string;
  };
}

/**
 * Verify GitHub webhook signature using HMAC SHA-256
 */
async function verifySignature(
  payload: string,
  signature: string | null
): Promise<boolean> {
  if (!WEBHOOK_SECRET) {
    console.warn("[WEBHOOK] No GITHUB_WEBHOOK_SECRET configured - skipping verification");
    return true; // Allow in dev/test without secret
  }

  if (!signature) {
    console.error("[WEBHOOK] No x-hub-signature-256 header");
    return false;
  }

  // GitHub sends signature as "sha256=<hash>"
  const sigParts = signature.split("=");
  if (sigParts.length !== 2 || sigParts[0] !== "sha256") {
    console.error("[WEBHOOK] Invalid signature format");
    return false;
  }

  const providedHash = sigParts[1];

  // Compute expected HMAC
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const hashBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload)
  );

  const expectedHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const verified = expectedHash === providedHash;
  if (!verified) {
    console.error("[WEBHOOK] Signature verification failed");
  }

  return verified;
}

/**
 * Extract priority from GitHub labels
 */
function extractPriority(labels: Array<{ name: string }>): string {
  for (const label of labels) {
    const priority = PRIORITY_MAP[label.name.toLowerCase()];
    if (priority) return priority;
  }
  return "p2_medium"; // default
}

/**
 * Extract tags from GitHub labels (excluding trigger labels and priority labels)
 */
function extractTags(labels: Array<{ name: string }>): string[] {
  return labels
    .map((l) => l.name.toLowerCase())
    .filter((name) => {
      return (
        !TRIGGER_LABELS.includes(name) &&
        !name.startsWith("priority:")
      );
    });
}

/**
 * Handle push events: index all changed files into github_file_index
 */
async function handlePushEvent(
  event: any,
  supabase: any
): Promise<{ files_indexed: number; branch: string; commits: number }> {
  const repo = event.repository?.full_name;
  const branch = (event.ref || "").replace("refs/heads/", "");
  const committer = event.sender?.login || "unknown";

  if (!repo || !branch) {
    console.warn("[WEBHOOK] Push event missing repo or ref");
    return { files_indexed: 0, branch: branch || "unknown", commits: 0 };
  }

  const rows: Array<Record<string, unknown>> = [];
  for (const commit of event.commits || []) {
    const commitMsg = (commit.message || "").substring(0, 200);
    for (const path of commit.added || []) {
      rows.push({
        repo, branch, file_path: path, commit_sha: commit.id,
        change_type: "added", committer, commit_message: commitMsg, source: "webhook",
      });
    }
    for (const path of commit.modified || []) {
      rows.push({
        repo, branch, file_path: path, commit_sha: commit.id,
        change_type: "modified", committer, commit_message: commitMsg, source: "webhook",
      });
    }
    for (const path of commit.removed || []) {
      rows.push({
        repo, branch, file_path: path, commit_sha: commit.id,
        change_type: "removed", committer, commit_message: commitMsg, source: "webhook",
      });
    }
  }

  if (rows.length > 0) {
    const { error } = await supabase.from("github_file_index")
      .upsert(rows, { onConflict: "repo,branch,file_path,commit_sha" });
    if (error) {
      console.error("[WEBHOOK] Failed to index files:", error);
    } else {
      console.log(`[WEBHOOK] Indexed ${rows.length} files from ${event.commits?.length || 0} commits on ${repo}/${branch}`);
    }
  }

  return { files_indexed: rows.length, branch, commits: event.commits?.length || 0 };
}

/**
 * Create work order from GitHub issue
 */
async function createWorkOrderFromIssue(
  supabase: any,
  event: GitHubIssueEvent
): Promise<{ success: boolean; work_order_id?: string; slug?: string; error?: string }> {
  const { issue, repository } = event;

  // Prepare WO parameters
  const name = issue.title;
  const objective = issue.body || issue.title;
  const priority = extractPriority(issue.labels);
  const tags = extractTags(issue.labels);
  
  // Add github tag and repo identifier
  tags.push("github");
  tags.push(`repo:${repository.full_name}`);

  // Prepare acceptance criteria from issue body sections
  let acceptanceCriteria = "";
  if (issue.body) {
    // Try to extract AC section from issue body
    const acMatch = issue.body.match(/##?\s*Acceptance Criteria[:\s]+([\s\S]*?)(?=##|$)/i);
    if (acMatch && acMatch[1]) {
      acceptanceCriteria = acMatch[1].trim();
    }
  }
  
  // Default ACs if none found
  if (!acceptanceCriteria) {
    acceptanceCriteria = `1. Implement solution as described in issue\n2. Changes verified and tested\n3. Evidence logged`;
  }

  console.log("[WEBHOOK] Creating WO from issue:", {
    name,
    priority,
    tags,
    issue_url: issue.html_url,
  });

  try {
    // Call create_draft_work_order RPC
    const { data, error } = await supabase.rpc("create_draft_work_order", {
      p_slug: null, // auto-generate
      p_name: name,
      p_objective: objective,
      p_priority: priority,
      p_source: "github",
      p_tags: tags,
      p_acceptance_criteria: acceptanceCriteria,
    });

    if (error) {
      console.error("[WEBHOOK] RPC error:", error);
      return { success: false, error: error.message };
    }

    console.log("[WEBHOOK] Created WO:", data);

    // Store GitHub issue metadata in client_info
    const workOrderId = data.id;
    const { error: updateError } = await supabase
      .from("work_orders")
      .update({
        client_info: {
          github_issue_url: issue.html_url,
          github_issue_number: issue.number,
          github_repo: repository.full_name,
          github_user: issue.user.login,
          created_via: "github-webhook",
        },
      })
      .eq("id", workOrderId);

    if (updateError) {
      console.warn("[WEBHOOK] Failed to update client_info:", updateError);
    }

    // Log to audit_log
    await supabase.from("audit_log").insert({
      event_type: "work_order_created",
      actor_type: "system",
      actor_id: "github-webhook",
      target_type: "work_order",
      target_id: workOrderId,
      action: "create",
      payload: {
        source: "github",
        issue_url: issue.html_url,
        issue_number: issue.number,
        repository: repository.full_name,
        triggered_by_label: event.label?.name,
      },
    });

    return {
      success: true,
      work_order_id: workOrderId,
      slug: data.slug,
    };
  } catch (err) {
    console.error("[WEBHOOK] Exception:", err);
    return { success: false, error: String(err) };
  }
}

/**
 * Main handler
 */
Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Only accept POST
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    // Read raw body for signature verification
    const rawBody = await req.text();
    
    // Verify GitHub webhook signature
    const signature = req.headers.get("x-hub-signature-256");
    const verified = await verifySignature(rawBody, signature);
    
    if (!verified) {
      return new Response(
        JSON.stringify({ error: "Invalid signature" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Parse event
    const event = JSON.parse(rawBody);
    const eventType = req.headers.get("x-github-event");
    const deliveryId = req.headers.get("x-github-delivery");

    console.log(`[WEBHOOK] Event: ${eventType}, Delivery: ${deliveryId}`);

    // Handle push events — index file changes for verification coverage
    if (eventType === "push") {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const supabase = createClient(supabaseUrl, supabaseKey);

      const result = await handlePushEvent(event, supabase);
      return new Response(
        JSON.stringify({ ok: true, ...result }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Only handle issues events with "labeled" action
    if (eventType !== "issues" || event.action !== "labeled") {
      return new Response(
        JSON.stringify({ message: `Event ignored: ${eventType}.${event.action || 'unknown'}` }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check if label is one of the trigger labels
    const labelName = event.label?.name.toLowerCase();
    if (!labelName || !TRIGGER_LABELS.includes(labelName)) {
      return new Response(
        JSON.stringify({ 
          message: `Label '${event.label?.name}' does not trigger WO creation`,
          trigger_labels: TRIGGER_LABELS 
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Create work order
    const result = await createWorkOrderFromIssue(supabase, event);

    if (!result.success) {
      return new Response(
        JSON.stringify({ error: result.error }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        work_order_id: result.work_order_id,
        slug: result.slug,
        message: `Work order ${result.slug} created from issue #${event.issue.number}`,
      }),
      { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[WEBHOOK] Handler error:", err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
