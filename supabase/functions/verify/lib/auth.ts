// verify/lib/auth.ts
// Authentication for /verify edge function
// Reuses kernel auth pattern: JWT -> service-role key fallback

import { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export interface AuthResult {
  authenticated: boolean;
  user?: { id: string; email?: string };
  error?: string;
}

export async function authenticateRequest(
  req: Request,
  supabase: SupabaseClient
): Promise<AuthResult> {
  const authHeader = req.headers.get("Authorization");

  if (!authHeader) {
    return { authenticated: false, error: "Missing Authorization header" };
  }

  try {
    const token = authHeader.replace(/^Bearer\s+/i, "");

    // Try JWT verification first
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (!error && user) {
      return { authenticated: true, user: { id: user.id, email: user.email } };
    }

    // Fallback: service-role key match
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (token === serviceKey) {
      return {
        authenticated: true,
        user: { id: "service-role", email: "service@supabase" },
      };
    }

    return { authenticated: false, error: "Invalid token" };
  } catch (err) {
    return { authenticated: false, error: (err as Error).message };
  }
}

/**
 * Validate agent_name against agents table.
 * Returns agent record or null if not found.
 */
export async function validateAgent(
  supabase: SupabaseClient,
  agentName: string
): Promise<{ id: string; name: string; role: string } | null> {
  const { data } = await supabase
    .from("agents")
    .select("id, name, role")
    .eq("name", agentName)
    .single();
  return data;
}
