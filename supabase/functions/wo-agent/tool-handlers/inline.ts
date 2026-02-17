// wo-agent/tool-handlers/inline.ts
// WO-0744: Extracted from tools.ts — remaining inline handlers
// Contains: memory, clarification, and sandbox tool handlers
import type { ToolContext, ToolResult } from "../tools.ts";

export async function handleSaveMemory(toolInput: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const { error: memErr } = await ctx.supabase
        .from("agent_memory")
        .upsert(
          {
            agent_id: ctx.agentName,
            memory_type: toolInput.memory_type,
            key: toolInput.key,
            value: toolInput.value,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "agent_id,memory_type,key" }
        );
      if (memErr) {
        return { success: false, error: `Failed to save memory: ${memErr.message}` };
      } else {
        return { success: true, data: { saved: true, key: toolInput.key, memory_type: toolInput.memory_type } };
      }
}

export async function handleRecallMemory(toolInput: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      let query = ctx.supabase
        .from("agent_memory")
        .select("key, memory_type, value, updated_at")
        .eq("agent_id", ctx.agentName)
        .order("updated_at", { ascending: false })
        .limit(50);
      if (toolInput.memory_type) {
        query = query.eq("memory_type", toolInput.memory_type);
      }
      const { data: memories, error: recallErr } = await query;
      if (recallErr) {
        return { success: false, error: `Failed to recall memories: ${recallErr.message}` };
      } else {
        return { success: true, data: { memories: memories || [], count: (memories || []).length } };
      }
}

export async function handleRequestClarification(toolInput: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      try {
        const clarificationUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/request-clarification`;
        const response = await fetch(clarificationUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({
            work_order_id: ctx.workOrderId,
            question: toolInput.question,
            context: toolInput.context,
            options: toolInput.options,
            urgency: toolInput.urgency || "normal",
          }),
        });
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: response.statusText }));
          return { success: false, error: `Clarification request failed: ${errorData.error || response.statusText}` };
        } else {
          const data = await response.json();
          // Set terminal flag to stop the agent loop
          return { success: true, data, terminal: true };
        }
      } catch (e: any) {
        return { success: false, error: `Failed to request clarification: ${e.message}` };
      }
}

export async function handleCheckClarification(toolInput: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      try {
        const checkUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/check-clarification`;
        const response = await fetch(checkUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({
            clarification_id: toolInput.clarification_id,
          }),
        });
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: response.statusText }));
          return { success: false, error: `Check clarification failed: ${errorData.error || response.statusText}` };
        } else {
          const data = await response.json();
          return { success: true, data };
        }
      } catch (e: any) {
        return { success: false, error: `Failed to check clarification: ${e.message}` };
      }
}

export async function handleSandboxExec(toolInput: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      try {
        // WO-0590: Read-only command whitelist -- block writes, pipes, redirects
        const ALLOWED_COMMANDS = new Set(["grep", "find", "wc", "cat", "head", "tail", "echo", "test", "ls", "file", "deno", "diff", "jq", "node", "npm", "npx", "tsc", "python3", "git", "curl", "sed"]);
        const cmd = (toolInput.command || "").trim();
        if (!ALLOWED_COMMANDS.has(cmd)) {
          return { success: false, error: `Command '${cmd}' is not in the sandbox whitelist. Allowed: ${[...ALLOWED_COMMANDS].join(", ")}` };
        }
        // Block shell injection via args: no pipes, redirects, semicolons, backticks
        const dangerousPatterns = /[|><;&`$(){}]/;
        const argsStr = (toolInput.args || []).join(" ");
        if (dangerousPatterns.test(argsStr)) {
          return { success: false, error: "Sandbox args contain blocked characters (pipes, redirects, semicolons, backticks). Use separate tool calls instead." };
        }

        // WO-0593: Read Fly Machine URL from system_settings
        const { data: flySettings } = await ctx.supabase
          .from("system_settings")
          .select("setting_key, setting_value")
          .in("setting_key", ["fly_machine_url", "fly_machine_token"]);
        const flyUrl = flySettings?.find((s: any) => s.setting_key === "fly_machine_url")?.setting_value;
        const flyToken = flySettings?.find((s: any) => s.setting_key === "fly_machine_token")?.setting_value;

        if (!flyUrl) {
          return { success: false, error: "Fly Machine URL not configured in system_settings (fly_machine_url)" };
        }

        // WO-0593: Git-pull-on-demand -- first sandbox call per WO triggers repo sync
        // Track per-WO git pull status via a simple static Set
        if (!(globalThis as any)._flyGitPulled) {
          (globalThis as any)._flyGitPulled = new Set<string>();
        }
        const pulledSet = (globalThis as any)._flyGitPulled as Set<string>;
        if (!pulledSet.has(ctx.workOrderId)) {
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
            pulledSet.add(ctx.workOrderId);
          } catch (_pullErr) {
            // Non-fatal: git pull failure shouldn't block exec
          }
        }

        // WO-0593: Call Fly Machine /exec endpoint
        const execCtrl = new AbortController();
        const execTimer = setTimeout(() => execCtrl.abort(), 30000);
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (flyToken && flyToken !== "not_required_public_endpoint") {
          headers["Authorization"] = `Bearer ${flyToken}`;
        }
        const response = await fetch(`${flyUrl}/exec`, {
          method: "POST",
          headers,
          signal: execCtrl.signal,
          body: JSON.stringify({
            command: toolInput.command,
            args: toolInput.args || [],
            timeout_ms: toolInput.timeout_ms || 30000,
            wo_slug: ctx.workOrderSlug,
          }),
        });
        clearTimeout(execTimer);

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: response.statusText }));
          return { success: false, error: `Sandbox exec failed (${response.status}): ${errorData.error || errorData.stderr || response.statusText}` };
        } else {
          const execResult = await response.json();
          const success = execResult.exit_code === 0;
          return {
            success,
            output: execResult.stdout || "",
            error: execResult.stderr || undefined,
            data: {
              stdout: execResult.stdout,
              stderr: execResult.stderr,
              exit_code: execResult.exit_code,
            },
          };
        }

        // Record mutation
        const cmdStr = `${toolInput.command} ${(toolInput.args || []).join(" ")}`;
        await recordMutation(
          ctx,
          "sandbox_exec",
          "sandbox",
          cmdStr.substring(0, 100),
          "EXEC",
          result.success,
          result.error,
          {
            command: toolInput.command,
            args: toolInput.args,
            exit_code: result.data?.exit_code,
          }
        );
      } catch (e: any) {
        if (e.name === "AbortError") {
          return { success: false, error: "Sandbox exec timed out after 30s" };
        } else {
          return { success: false, error: `Sandbox exec error: ${e.message}` };
        }
      }
}

export async function handleRunTests(toolInput: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      try {
        // WO-0594: Run tests via Fly Machine sandbox
        const { data: flySettings } = await ctx.supabase
          .from("system_settings")
          .select("setting_key, setting_value")
          .in("setting_key", ["fly_machine_url", "fly_machine_token"]);
        const flyUrl = flySettings?.find((s: any) => s.setting_key === "fly_machine_url")?.setting_value;
        const flyToken = flySettings?.find((s: any) => s.setting_key === "fly_machine_token")?.setting_value;

        if (!flyUrl) {
          return { success: false, error: "Fly Machine URL not configured in system_settings (fly_machine_url)" };
        }

        // Git-pull to ensure latest code
        if (!(globalThis as any)._flyGitPulled) {
          (globalThis as any)._flyGitPulled = new Set<string>();
        }
        const pulledSet = (globalThis as any)._flyGitPulled as Set<string>;
        if (!pulledSet.has(ctx.workOrderId)) {
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
            pulledSet.add(ctx.workOrderId);
          } catch (_pullErr) {
            // Non-fatal
          }
        }

        // Parse test command Ã¢ÂÂ default to npm test
        const testCmd = (toolInput.test_command || "npm test").trim();
        const parts = testCmd.split(/\s+/);
        const command = parts[0];
        const args = parts.slice(1);

        // Validate command against whitelist
        const TEST_ALLOWED = new Set(["npm", "npx", "node", "deno", "tsc"]);
        if (!TEST_ALLOWED.has(command)) {
          return { success: false, error: `Test command '${command}' not allowed. Use: ${[...TEST_ALLOWED].join(", ")}` };
        }

        const execCtrl = new AbortController();
        const execTimer = setTimeout(() => execCtrl.abort(), 120000); // 120s timeout for tests
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
            timeout_ms: 120000,
            wo_slug: ctx.workOrderSlug,
          }),
        });
        clearTimeout(execTimer);

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: response.statusText }));
          return { success: false, error: `Test execution failed (${response.status}): ${errorData.error || errorData.stderr || response.statusText}` };
        } else {
          const execResult = await response.json();
          const success = execResult.exit_code === 0;
          return {
            success,
            output: execResult.stdout || "",
            error: execResult.stderr || undefined,
            data: {
              stdout: execResult.stdout,
              stderr: execResult.stderr,
              exit_code: execResult.exit_code,
              test_command: testCmd,
            },
          };
        }

        // Record mutation
        await recordMutation(
          ctx,
          "run_tests",
          "test_suite",
          testCmd.substring(0, 100),
          "TEST",
          result.success,
          result.error,
          { test_command: testCmd, exit_code: result.data?.exit_code }
        );
      } catch (e: any) {
        if (e.name === "AbortError") {
          return { success: false, error: "Test execution timed out after 120s" };
        } else {
          return { success: false, error: `Test execution error: ${e.message}` };
        }
      }
}

export async function handleSandboxWriteFile(toolInput: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      try {
        const { data: flySettings } = await ctx.supabase
          .from("system_settings")
          .select("setting_key, setting_value")
          .in("setting_key", ["fly_machine_url", "fly_machine_token"]);
        const flyUrl = flySettings?.find((s: any) => s.setting_key === "fly_machine_url")?.setting_value;
        const flyToken = flySettings?.find((s: any) => s.setting_key === "fly_machine_token")?.setting_value;

        if (!flyUrl) {
          return { success: false, error: "Fly Machine URL not configured" };
        }

        const filePath = toolInput.path || "";
        if (!filePath.startsWith("/workspace")) {
          return { success: false, error: `Path must be under /workspace. Got: ${filePath}` };
        }

        // Use tee to write content via stdin simulation — exec endpoint with echo piped concept
        // Actually use the /exec endpoint with 'tee' command
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (flyToken && flyToken !== "not_required_public_endpoint") {
          headers["Authorization"] = `Bearer ${flyToken}`;
        }

        // Ensure parent directory exists first
        const parentDir = filePath.substring(0, filePath.lastIndexOf("/"));
        if (parentDir && parentDir !== "/workspace") {
          await fetch(`${flyUrl}/exec`, {
            method: "POST",
            headers,
            body: JSON.stringify({ command: "mkdir", args: ["-p", parentDir], wo_slug: ctx.workOrderSlug }),
          });
        }

        // Write via echo + tee pipeline using the /pipeline endpoint
        const content = toolInput.content || "";
        const response = await fetch(`${flyUrl}/pipeline`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            commands: [
              { command: "tee", args: [filePath] },
            ],
            wo_slug: ctx.workOrderSlug,
            timeout_ms: 10000,
          }),
        });

        // tee reads from stdin but /pipeline doesn't pipe stdin
        // Use echo + redirect approach instead — write via node one-liner
        const writeResponse = await fetch(`${flyUrl}/exec`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            command: "node",
            args: ["-e", `require('fs').writeFileSync('${filePath.replace(/'/g, "\\'")}', Buffer.from('${Buffer.from(content).toString("base64")}', 'base64')); console.log(JSON.stringify({bytes: ${content.length}}))`],
            wo_slug: ctx.workOrderSlug,
            timeout_ms: 10000,
          }),
        });

        if (!writeResponse.ok) {
          return { success: false, error: `Write failed: ${writeResponse.statusText}` };
        } else {
          const writeResult = await writeResponse.json();
          if (writeResult.exit_code !== 0) {
            return { success: false, error: writeResult.stderr || "Write failed" };
          } else {
            return { success: true, path: filePath, bytes_written: content.length };
          }
        }

        await recordMutation(ctx, "sandbox_write_file", "sandbox", filePath, "WRITE", result.success, result.error, { path: filePath, bytes: content.length });
      } catch (e: any) {
        return { success: false, error: `Sandbox write error: ${e.message}` };
      }
}

export async function handleSandboxPipeline(toolInput: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      try {
        const { data: flySettings } = await ctx.supabase
          .from("system_settings")
          .select("setting_key, setting_value")
          .in("setting_key", ["fly_machine_url", "fly_machine_token"]);
        const flyUrl = flySettings?.find((s: any) => s.setting_key === "fly_machine_url")?.setting_value;
        const flyToken = flySettings?.find((s: any) => s.setting_key === "fly_machine_token")?.setting_value;

        if (!flyUrl) {
          return { success: false, error: "Fly Machine URL not configured" };
        }

        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (flyToken && flyToken !== "not_required_public_endpoint") {
          headers["Authorization"] = `Bearer ${flyToken}`;
        }

        const pipelineCtrl = new AbortController();
        const pipelineTimer = setTimeout(() => pipelineCtrl.abort(), 60000);
        const response = await fetch(`${flyUrl}/pipeline`, {
          method: "POST",
          headers,
          signal: pipelineCtrl.signal,
          body: JSON.stringify({
            commands: toolInput.commands || [],
            timeout_ms: toolInput.timeout_ms || 30000,
            wo_slug: ctx.workOrderSlug,
          }),
        });
        clearTimeout(pipelineTimer);

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: response.statusText }));
          return { success: false, error: `Pipeline failed (${response.status}): ${errorData.error || response.statusText}` };
        } else {
          const pipelineResult = await response.json();
          return {
            success: pipelineResult.overall_success,
            data: pipelineResult,
            output: pipelineResult.steps?.map((s: any) => s.stdout).join("\n") || "",
          };
        }

        const cmdSummary = (toolInput.commands || []).map((c: any) => c.command).join(" | ");
        await recordMutation(ctx, "sandbox_pipeline", "sandbox", cmdSummary.substring(0, 100), "PIPELINE", result.success, result.error, { steps: (toolInput.commands || []).length });
      } catch (e: any) {
        if (e.name === "AbortError") {
          return { success: false, error: "Pipeline timed out after 60s" };
        } else {
          return { success: false, error: `Pipeline error: ${e.message}` };
        }
      }
}

