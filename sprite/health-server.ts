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

  // Execute a pipeline of sequential commands (POST)
  // Ported from fly-sandbox/exec-server.js — runs commands in order, stops on first failure
  if (url.pathname === "/pipeline" && req.method === "POST") {
    try {
      const body = await req.json();
      const { commands = [], timeout_ms = 30000 } = body;

      if (!Array.isArray(commands) || commands.length === 0) {
        return new Response(
          JSON.stringify({ steps: [], overall_success: false, error: "commands array is required" }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }

      const steps: Array<{
        command: string;
        args: string[];
        stdout: string;
        stderr: string;
        exit_code: number;
        duration_ms: number;
      }> = [];

      for (const step of commands) {
        const { command, args = [] } = step;
        if (!command) {
          steps.push({ command: "", args, stdout: "", stderr: "command is required", exit_code: 1, duration_ms: 0 });
          return new Response(
            JSON.stringify({ steps, overall_success: false }),
            { headers: { "content-type": "application/json" } }
          );
        }

        const startTime = Date.now();
        try {
          const cmd = new Deno.Command(command, {
            args,
            cwd: "/workspace",
            stdout: "piped",
            stderr: "piped",
          });

          const abortController = new AbortController();
          const timeoutId = setTimeout(() => abortController.abort(), timeout_ms);
          const output = await cmd.output();
          clearTimeout(timeoutId);

          const duration_ms = Date.now() - startTime;
          const stdout = new TextDecoder().decode(output.stdout).substring(0, 50000);
          const stderr = new TextDecoder().decode(output.stderr).substring(0, 10000);

          steps.push({ command, args, stdout, stderr, exit_code: output.code, duration_ms });

          if (output.code !== 0) {
            return new Response(
              JSON.stringify({ steps, overall_success: false }),
              { headers: { "content-type": "application/json" } }
            );
          }
        } catch (e) {
          const duration_ms = Date.now() - startTime;
          steps.push({ command, args, stdout: "", stderr: String(e), exit_code: 1, duration_ms });
          return new Response(
            JSON.stringify({ steps, overall_success: false }),
            { headers: { "content-type": "application/json" } }
          );
        }
      }

      return new Response(
        JSON.stringify({ steps, overall_success: true }),
        { headers: { "content-type": "application/json" } }
      );
    } catch (e) {
      return new Response(
        JSON.stringify({ steps: [], overall_success: false, error: String(e) }),
        { status: 400, headers: { "content-type": "application/json" } }
      );
    }
  }

  // Execute a single command (POST)
  if (url.pathname === "/exec" && req.method === "POST") {
    try {
      const body = await req.json();
      const { command, args = [], timeout_ms = 30000 } = body;

      if (!command) {
        return new Response(
          JSON.stringify({ success: false, output: "command is required", exit_code: 1 }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }

      const cmd = new Deno.Command(command, {
        args,
        cwd: "/workspace",
        stdout: "piped",
        stderr: "piped",
      });

      const output = await cmd.output();
      const stdout = new TextDecoder().decode(output.stdout).substring(0, 50000);
      const stderr = new TextDecoder().decode(output.stderr).substring(0, 10000);

      return new Response(
        JSON.stringify({
          success: output.code === 0,
          output: stdout + (stderr ? "\n" + stderr : ""),
          exit_code: output.code,
        }),
        { headers: { "content-type": "application/json" } }
      );
    } catch (e) {
      return new Response(
        JSON.stringify({ success: false, output: String(e), exit_code: 1 }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
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
