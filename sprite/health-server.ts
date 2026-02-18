// Sprite Health Server — lightweight HTTP endpoint for Fly Machine health checks
// Also serves as the control plane for sprite lifecycle management

const PORT = parseInt(Deno.env.get("PORT") || "8080");

interface SpriteStatus {
  status: "idle" | "running" | "completed" | "failed";
  wo_id: string | null;
  wo_slug: string | null;
  started_at: string | null;
  mutation_count: number;
  uptime_seconds: number;
}

const startTime = Date.now();

async function getMutationCount(): Promise<number> {
  try {
    const content = await Deno.readTextFile("/workspace/.mutations/fs-events.jsonl");
    return content.trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function getAgentStatus(): Promise<string> {
  try {
    const status = await Deno.readTextFile("/workspace/.sprite-status");
    return status.trim();
  } catch {
    return "idle";
  }
}

Deno.serve({ port: PORT }, async (req: Request) => {
  const url = new URL(req.url);

  // Health check
  if (url.pathname === "/health" || url.pathname === "/") {
    const mutationCount = await getMutationCount();
    const agentStatus = await getAgentStatus();

    const status: SpriteStatus = {
      status: agentStatus as SpriteStatus["status"],
      wo_id: Deno.env.get("WO_ID") || null,
      wo_slug: Deno.env.get("WO_SLUG") || null,
      started_at: Deno.env.get("SPRITE_STARTED_AT") || null,
      mutation_count: mutationCount,
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    };

    return new Response(JSON.stringify(status), {
      headers: { "content-type": "application/json" },
    });
  }

  // Get mutation log
  if (url.pathname === "/mutations") {
    try {
      const content = await Deno.readTextFile("/workspace/.mutations/fs-events.jsonl");
      return new Response(content, {
        headers: { "content-type": "application/x-ndjson" },
      });
    } catch {
      return new Response("[]", {
        headers: { "content-type": "application/json" },
      });
    }
  }

  // Get evidence package (assembled from mutations + git diff + test output)
  if (url.pathname === "/evidence") {
    try {
      const evidence = await Deno.readTextFile("/workspace/.mutations/evidence.json");
      return new Response(evidence, {
        headers: { "content-type": "application/json" },
      });
    } catch {
      return new Response(JSON.stringify({ error: "No evidence assembled yet" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
  }

  // Trigger agent execution (POST with WO context)
  if (url.pathname === "/run" && req.method === "POST") {
    try {
      const body = await req.json();
      // Write context to signal file — entrypoint picks it up
      await Deno.writeTextFile("/workspace/.run-context.json", JSON.stringify(body));
      await Deno.writeTextFile("/workspace/.sprite-status", "running");
      return new Response(JSON.stringify({ ok: true, message: "Agent execution triggered" }), {
        headers: { "content-type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  return new Response("Not Found", { status: 404 });
});
