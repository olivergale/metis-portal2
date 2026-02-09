// validate-frontend/index.ts
// WO-0037: Pre-commit frontend validation for daemon execution flow
// Layer 1 of FRONTEND-AGENT-TEAM.md
//
// Called by daemon AFTER Claude Code exits, BEFORE git commit
// For each modified .html file: extract <script> blocks, validate with node --check
// For each .js/.ts file: validate with node --check
// If ANY check fails: log to execution_log, do NOT commit, call /fail

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  files_checked: number;
  scripts_checked: number;
}

interface ValidationError {
  file: string;
  error: string;
  line?: number;
  column?: number;
  script_block_index?: number;
}

interface FileValidation {
  path: string;
  content: string;
}

/**
 * Extract <script> blocks from HTML content
 * Returns array of { script, index } objects
 */
function extractScriptBlocks(html: string): Array<{ script: string; index: number }> {
  const blocks: Array<{ script: string; index: number }> = [];

  // Match <script> tags, handle both inline and src attributes
  // We only validate inline scripts (src scripts are validated separately)
  const scriptRegex = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

  let match;
  let index = 0;
  while ((match = scriptRegex.exec(html)) !== null) {
    const script = match[1].trim();
    if (script.length > 0) {
      blocks.push({ script, index });
      index++;
    }
  }

  return blocks;
}

/**
 * Validate JavaScript code using Node.js --check flag
 * Returns error string if invalid, null if valid
 */
async function validateJavaScript(code: string, filename: string): Promise<string | null> {
  try {
    // Write code to temporary file
    const tempFile = `/tmp/validate_${Date.now()}_${Math.random().toString(36).slice(2)}.js`;
    await Deno.writeTextFile(tempFile, code);

    // Run node --check
    const command = new Deno.Command("node", {
      args: ["--check", tempFile],
      stdout: "piped",
      stderr: "piped",
    });

    const { code: exitCode, stderr } = await command.output();

    // Clean up temp file
    try {
      await Deno.remove(tempFile);
    } catch {
      // Ignore cleanup errors
    }

    if (exitCode !== 0) {
      const errorText = new TextDecoder().decode(stderr);
      // Parse error to extract line/column if available
      return errorText.replace(tempFile, filename);
    }

    return null;
  } catch (error) {
    return `Validation error: ${(error as Error).message}`;
  }
}

/**
 * Validate a single file (HTML with script extraction or direct JS/TS)
 */
async function validateFile(file: FileValidation): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];
  const { path, content } = file;

  if (path.endsWith('.html') || path.endsWith('.htm')) {
    // Extract and validate script blocks
    const scriptBlocks = extractScriptBlocks(content);

    for (const { script, index } of scriptBlocks) {
      const error = await validateJavaScript(script, `${path} (script block ${index})`);
      if (error) {
        errors.push({
          file: path,
          error: error,
          script_block_index: index,
        });
      }
    }
  } else if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.ts')) {
    // Validate JS/TS file directly
    const error = await validateJavaScript(content, path);
    if (error) {
      errors.push({
        file: path,
        error: error,
      });
    }
  }

  return errors;
}

/**
 * Main validation function
 */
async function validateFrontendFiles(files: FileValidation[]): Promise<ValidationResult> {
  const allErrors: ValidationError[] = [];
  let scriptsChecked = 0;

  for (const file of files) {
    const fileErrors = await validateFile(file);
    allErrors.push(...fileErrors);

    // Count scripts checked
    if (file.path.endsWith('.html') || file.path.endsWith('.htm')) {
      const scriptBlocks = extractScriptBlocks(file.content);
      scriptsChecked += scriptBlocks.length;
    } else if (file.path.endsWith('.js') || file.path.endsWith('.mjs') || file.path.endsWith('.ts')) {
      scriptsChecked += 1;
    }
  }

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    files_checked: files.length,
    scripts_checked: scriptsChecked,
  };
}

/**
 * Log validation phase to execution_log
 */
async function logValidationPhase(
  supabase: any,
  workOrderId: string,
  result: ValidationResult
): Promise<void> {
  try {
    await supabase
      .from("work_order_execution_log")
      .insert({
        work_order_id: workOrderId,
        phase: "frontend_validation",
        agent_name: "validate-frontend",
        detail: {
          valid: result.valid,
          files_checked: result.files_checked,
          scripts_checked: result.scripts_checked,
          error_count: result.errors.length,
          errors: result.errors.slice(0, 10), // Limit to first 10 errors
          validated_at: new Date().toISOString(),
        },
        iteration: 1,
      });
  } catch (error) {
    console.error("[VALIDATION-LOG] Failed to log to execution_log:", error);
  }
}

/**
 * Call /fail endpoint to transition WO to failed state
 */
async function failWorkOrder(
  workOrderId: string,
  errors: ValidationError[]
): Promise<void> {
  const baseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const errorSummary = errors
    .slice(0, 5)
    .map((e) => `${e.file}: ${e.error.split('\n')[0]}`)
    .join('\n');

  const reason = `Frontend validation failed (${errors.length} error${errors.length > 1 ? 's' : ''}):\n\n${errorSummary}${errors.length > 5 ? `\n\n... and ${errors.length - 5} more errors` : ''}`;

  try {
    const response = await fetch(`${baseUrl}/functions/v1/work-order-executor/fail`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        work_order_id: workOrderId,
        reason: reason,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[VALIDATION-FAIL] Failed to call /fail:", errorText);
    } else {
      console.log(`[VALIDATION-FAIL] Work order ${workOrderId} transitioned to failed`);
    }
  } catch (error) {
    console.error("[VALIDATION-FAIL] Exception calling /fail:", error);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const { work_order_id, files } = await req.json();

    if (!work_order_id) {
      return new Response(
        JSON.stringify({ error: "work_order_id required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!files || !Array.isArray(files) || files.length === 0) {
      return new Response(
        JSON.stringify({ error: "files array required (array of {path, content})" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[VALIDATE-FRONTEND] Validating ${files.length} files for WO ${work_order_id}`);

    // Run validation
    const result = await validateFrontendFiles(files);

    // Log to execution_log
    await logValidationPhase(supabase, work_order_id, result);

    // If validation failed, call /fail
    if (!result.valid) {
      console.error(`[VALIDATE-FRONTEND] Validation failed with ${result.errors.length} errors`);
      await failWorkOrder(work_order_id, result.errors);

      return new Response(
        JSON.stringify({
          valid: false,
          ...result,
          message: "Frontend validation failed. Work order transitioned to failed state.",
        }),
        {
          status: 422,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    }

    console.log(`[VALIDATE-FRONTEND] ✓ All checks passed`);

    return new Response(
      JSON.stringify({
        valid: true,
        ...result,
        message: "Frontend validation passed. Safe to commit.",
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("[VALIDATE-FRONTEND] Error:", error);
    return new Response(
      JSON.stringify({
        error: (error as Error).message,
        stack: (error as Error).stack,
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
