// github-deploy/index.ts v2
// Deploy files to GitHub repos + create new repos
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface DeployRequest {
  repo: string;
  path: string;
  content: string;
  message: string;
  branch?: string;
}

interface CreateRepoRequest {
  name: string;
  description?: string;
  private?: boolean;
  org?: string;
}

async function getGitHubToken(): Promise<string> {
  const sbUrl = Deno.env.get("SUPABASE_URL")!;
  const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(sbUrl, sbKey);

  const { data, error } = await sb
    .from("secrets")
    .select("value")
    .eq("key", "GITHUB_TOKEN")
    .single();

  if (error || !data?.value) {
    throw new Error("GitHub token not found in secrets");
  }

  return data.value;
}

async function getFileSha(token: string, repo: string, path: string, branch: string): Promise<string | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`,
      {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "Endgame-Deploy"
        }
      }
    );

    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);

    const data = await response.json();
    return data.sha;
  } catch {
    return null;
  }
}

async function deployFile(token: string, repo: string, path: string, content: string, message: string, branch: string): Promise<any> {
  const sha = await getFileSha(token, repo, path, branch);
  const encodedContent = btoa(unescape(encodeURIComponent(content)));

  const body: any = {
    message,
    content: encodedContent,
    branch
  };

  if (sha) {
    body.sha = sha;
  }

  const response = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "Endgame-Deploy"
      },
      body: JSON.stringify(body)
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub API error: ${response.status} - ${error}`);
  }

  return response.json();
}

async function createRepo(token: string, req: CreateRepoRequest): Promise<any> {
  const url = req.org
    ? `https://api.github.com/orgs/${req.org}/repos`
    : 'https://api.github.com/user/repos';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'Endgame-Deploy'
    },
    body: JSON.stringify({
      name: req.name,
      description: req.description || `Created by METIS Build Pipeline`,
      private: req.private !== false,
      auto_init: true,
      gitignore_template: 'Node',
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub create repo error: ${response.status} - ${error}`);
  }

  return response.json();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method not allowed" }),
        { status: 405, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    const url = new URL(req.url);
    const action = url.pathname.split('/').pop();

    const token = await getGitHubToken();

    // Route: /create-repo
    if (action === 'create-repo') {
      const body: CreateRepoRequest = await req.json();

      if (!body.name) {
        return new Response(
          JSON.stringify({ error: "Missing required field: name" }),
          { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }

      const result = await createRepo(token, body);

      return new Response(
        JSON.stringify({
          success: true,
          repo_url: result.clone_url,
          html_url: result.html_url,
          full_name: result.full_name,
          ssh_url: result.ssh_url,
          message: `Created repo: ${result.full_name}`
        }),
        { headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // Default route: deploy file
    const body: DeployRequest = await req.json();

    if (!body.repo || !body.path || !body.content || !body.message) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: repo, path, content, message" }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    const branch = body.branch || "main";

    const result = await deployFile(
      token,
      body.repo,
      body.path,
      body.content,
      body.message,
      branch
    );

    return new Response(
      JSON.stringify({
        success: true,
        commit: result.commit?.sha,
        url: result.content?.html_url,
        message: `Deployed ${body.path} to ${body.repo}`
      }),
      { headers: { ...CORS, "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    console.error("github-deploy error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});
