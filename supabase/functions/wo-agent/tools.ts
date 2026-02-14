// wo-agent/tools.ts v4.1
// WO-0153: Fixed imports for Deno Deploy compatibility
// WO-0166: Role-based tool filtering per agent identity
// WO-0245: delegate_subtask tool for WO tree execution
// WO-0257: github_edit_file patch-based editing
// WO-0485: Mutation recording in all mutating tool handlers
// WO-0491: Remediation - trigger re-deploy to confirm instrumentation
// Tool definitions for the agentic work order executor
// Each tool maps to an Anthropic tool_use schema + a dispatch handler

// Tool type from Anthropic SDK -- inlined to avoid deep npm sub-path import that breaks Deno edge runtime
type Tool = { name: string; description: string; input_schema: Record<string, any> };