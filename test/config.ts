// Test configuration for integration tests
// Supports both CI and local development environments

export interface TestConfig {
  supabaseUrl: string;
  supabaseKey: string;
  testMode: "ci" | "local";
  projectRef: string;
}

export function getTestConfig(): TestConfig {
  const testMode = Deno.env.get("CI") === "true" ? "ci" : "local";

  // In CI, use GitHub secrets; locally use .env
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://phfblljwuvzqzlbzkzpr.supabase.co";
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const projectRef = Deno.env.get("SUPABASE_PROJECT_REF") || "phfblljwuvzqzlbzkzpr";

  if (!supabaseKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY environment variable is required");
  }

  return {
    supabaseUrl,
    supabaseKey,
    testMode,
    projectRef,
  };
}

// Test data cleanup helpers
export async function cleanupTestWorkOrders(supabaseUrl: string, supabaseKey: string) {
  const testPrefix = "WO-TEST-";

  const response = await fetch(`${supabaseUrl}/rest/v1/work_orders?slug=like.${testPrefix}*`, {
    method: "DELETE",
    headers: {
      "apikey": supabaseKey,
      "Authorization": `Bearer ${supabaseKey}`,
      "Prefer": "return=minimal",
    },
  });

  if (!response.ok) {
    console.warn(`Failed to cleanup test work orders: ${response.statusText}`);
  }
}
