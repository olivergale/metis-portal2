/**
 * Error classification for mutation tracking
 * Maps error strings to standardized error taxonomy classes
 */

export function classifyError(errorMessage: string): string {
  if (!errorMessage) {
    return "unknown";
  }

  const msg = errorMessage.toLowerCase();

  // SQL syntax errors
  if (msg.includes("syntax error") || msg.includes("sql syntax")) {
    return "sql_syntax";
  }

  // RLS violations
  if (msg.includes("row-level security") || msg.includes("rls")) {
    return "rls_violation";
  }

  // Schema mismatches (missing tables, columns, relations)
  if (msg.includes("does not exist") || msg.includes("column") || msg.includes("relation")) {
    return "schema_mismatch";
  }

  // Encoding errors
  if (msg.includes("utf") || msg.includes("encoding") || msg.includes("bytea")) {
    return "encoding_error";
  }

  // GitHub match failures
  if (msg.includes("match not unique") || msg.includes("no matching")) {
    return "github_match_failure";
  }

  // GitHub API errors
  if (msg.includes("github api") || msg.includes("404") || msg.includes("422")) {
    return "github_api_error";
  }

  // Timeout errors
  if (msg.includes("timeout") || msg.includes("deadline")) {
    return "timeout";
  }

  // Enforcement/bypass blocks
  if (msg.includes("bypass") || msg.includes("enforcement") || msg.includes("blocked")) {
    return "enforcement_blocked";
  }

  // Default fallback
  return "unknown";
}
