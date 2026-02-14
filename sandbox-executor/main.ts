import { isCommandAllowed } from "./whitelist.ts";

const SANDBOX_AUTH_TOKEN = Deno.env.get("SANDBOX_AUTH_TOKEN");
const MAX_OUTPUT_SIZE = 64 * 1024; // 64KB
const MAX_CONCURRENT = 4;
let currentConcurrent = 0;

interface ExecRequest {
  command: string;
  args: string[];
  files?: Array<{ path: string; content: string }>;
  timeout_ms?: number;
}

interface ExecResponse {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
  duration_ms: number;
}

function truncateOutput(output: string, maxSize: number): string {
  if (output.length <= maxSize) return output;
  const marker = "\n[... OUTPUT TRUNCATED - EXCEEDED 64KB LIMIT ...]\n";
  return output.substring(0, maxSize - marker.length) + marker;
}

async function executeCommand(
  req: ExecRequest,
): Promise<ExecResponse> {
  const startTime = Date.now();
  const timeout = Math.min(req.timeout_ms || 30000, 120000);
  
  // Create temp directory
  const workspaceId = crypto.randomUUID();
  const workspaceDir = `/workspace/${workspaceId}`;
  await Deno.mkdir(workspaceDir, { recursive: true });

  try {
    // Write files if provided
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const filePath = `${workspaceDir}/${file.path}`;
        const dir = filePath.substring(0, filePath.lastIndexOf("/"));
        if (dir !== workspaceDir) {
          await Deno.mkdir(dir, { recursive: true });
        }
        await Deno.writeTextFile(filePath, file.content);
      }
    }

    // Execute command with timeout
    const command = new Deno.Command(req.command, {
      args: req.args,
      cwd: workspaceDir,
      stdout: "piped",
      stderr: "piped",
    });

    const process = command.spawn();
    
    // Race between execution and timeout
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), timeout);
    });

    const result = await Promise.race([
      process.output(),
      timeoutPromise,
    ]);

    if (result === "timeout") {
      // Kill the process
      try {
        process.kill("SIGTERM");
      } catch {
        // Ignore errors
      }
      
      const duration = Date.now() - startTime;
      return {
        stdout: "",
        stderr: `Command timed out after ${timeout}ms`,
        exit_code: -1,
        timed_out: true,
        duration_ms: duration,
      };
    }

    const { code, stdout, stderr } = result as Deno.CommandOutput;
    const duration = Date.now() - startTime;

    const stdoutText = new TextDecoder().decode(stdout);
    const stderrText = new TextDecoder().decode(stderr);

    return {
      stdout: truncateOutput(stdoutText, MAX_OUTPUT_SIZE),
      stderr: truncateOutput(stderrText, MAX_OUTPUT_SIZE),
      exit_code: code,
      timed_out: false,
      duration_ms: duration,
    };
  } finally {
    // Clean up workspace
    try {
      await Deno.remove(workspaceDir, { recursive: true });
    } catch (err) {
      console.error(`Failed to clean up ${workspaceDir}:`, err);
    }
  }
}

async function handleExec(req: Request): Promise<Response> {
  // Check auth
  const authHeader = req.headers.get("authorization");
  const token = authHeader?.replace("Bearer ", "");
  
  if (!SANDBOX_AUTH_TOKEN || token !== SANDBOX_AUTH_TOKEN) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }

  // Check concurrency limit
  if (currentConcurrent >= MAX_CONCURRENT) {
    return new Response(
      JSON.stringify({ error: "Too many concurrent requests", concurrent: currentConcurrent }),
      { status: 429, headers: { "content-type": "application/json" } },
    );
  }

  currentConcurrent++;
  try {
    const body: ExecRequest = await req.json();

    // Validate command whitelist
    if (!isCommandAllowed(body.command, body.args || [])) {
      return new Response(
        JSON.stringify({ error: "Command not allowed", command: body.command }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }

    const result = await executeCommand(body);
    
    return new Response(
      JSON.stringify(result),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    console.error("Execution error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error", message: String(err) }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  } finally {
    currentConcurrent--;
  }
}

function handleHealth(): Response {
  return new Response(
    JSON.stringify({ status: "ok", concurrent: currentConcurrent }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  
  if (url.pathname === "/health" && req.method === "GET") {
    return handleHealth();
  }
  
  if (url.pathname === "/exec" && req.method === "POST") {
    return await handleExec(req);
  }

  return new Response("Not Found", { status: 404 });
}

const port = parseInt(Deno.env.get("PORT") || "8080");
console.log(`Sandbox executor listening on port ${port}`);
Deno.serve({ port }, handler);
