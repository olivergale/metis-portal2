// test-deploy-success - working function for testing deployment validation gate
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(async (req: Request) => {
  return new Response(
    JSON.stringify({
      success: true,
      message: "Test deployment validation gate - SUCCESS PATH",
      timestamp: new Date().toISOString()
    }),
    {
      headers: { "Content-Type": "application/json" }
    }
  );
});