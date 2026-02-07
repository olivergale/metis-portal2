import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_PROJECT_REF = Deno.env.get('SUPABASE_PROJECT_REF') || 'phfblljwuvzqzlbzkzpr';
const SUPABASE_ACCESS_TOKEN = Deno.env.get('SUPABASE_ACCESS_TOKEN');
const SUPABASE_MANAGEMENT_API = 'https://api.supabase.com/v1';

interface DeployRequest {
  functionName: string;
  functionSlug: string;
  sourceCode: string;
  entrypointPath?: string;
  verifyJwt?: boolean;
}

interface WorkflowResponse {
  success: boolean;
  branchId?: string;
  branchRef?: string;
  deploymentResult?: any;
  smokeTestResult?: any;
  mergeResult?: any;
  error?: string;
  phase?: string;
  cleanup?: boolean;
}

async function callManagementAPI(path: string, method: string = 'GET', body?: any) {
  const url = `${SUPABASE_MANAGEMENT_API}${path}`;
  const headers: HeadersInit = {
    'Authorization': `Bearer ${SUPABASE_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  };

  const options: RequestInit = {
    method,
    headers,
  };

  if (body && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`API error: ${response.status} - ${JSON.stringify(data)}`);
  }

  return data;
}

async function createBranch(branchName: string): Promise<{ id: string; ref: string }> {
  console.log(`Creating branch: ${branchName}`);
  const result = await callManagementAPI(
    `/projects/${SUPABASE_PROJECT_REF}/branches`,
    'POST',
    { name: branchName }
  );
  return { id: result.id, ref: result.project_ref };
}

async function waitForBranchReady(branchId: string, maxWaitMs: number = 180000): Promise<boolean> {
  console.log(`Waiting for branch ${branchId} to be ready...`);
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const branches = await callManagementAPI(`/projects/${SUPABASE_PROJECT_REF}/branches`);
    const branch = branches.find((b: any) => b.id === branchId);

    if (!branch) {
      throw new Error(`Branch ${branchId} not found`);
    }

    console.log(`Branch status: ${branch.status}`);

    if (branch.status === 'ACTIVE_HEALTHY') {
      return true;
    }

    if (branch.status.includes('FAILED') || branch.status.includes('ERROR')) {
      throw new Error(`Branch failed to initialize: ${branch.status}`);
    }

    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  throw new Error(`Branch did not become ready within ${maxWaitMs}ms`);
}

async function deployToStagingBranch(branchRef: string, deployRequest: DeployRequest): Promise<any> {
  console.log(`Deploying function ${deployRequest.functionSlug} to staging branch ${branchRef}`);

  const deployPayload = {
    slug: deployRequest.functionSlug,
    name: deployRequest.functionName,
    source_code: deployRequest.sourceCode,
    entrypoint_path: deployRequest.entrypointPath || 'index.ts',
    verify_jwt: deployRequest.verifyJwt ?? true,
    import_map: false,
  };

  const result = await callManagementAPI(
    `/projects/${branchRef}/functions/${deployRequest.functionSlug}`,
    'POST',
    deployPayload
  );

  return result;
}

async function runSmokeTest(
  branchRef: string,
  functionSlug: string,
  apikey?: string
): Promise<{ passed: boolean; status?: number; error?: string; body?: string }> {
  console.log(`Running smoke test on ${functionSlug} in branch ${branchRef}`);

  try {
    const url = `https://${branchRef}.supabase.co/functions/v1/${functionSlug}`;
    console.log(`Testing URL: ${url}`);

    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };

    if (apikey) {
      headers['apikey'] = apikey;
      headers['Authorization'] = `Bearer ${apikey}`;
    }

    const response = await fetch(url, {
      method: 'GET',
      headers,
    });

    const responseBody = await response.text();
    const passed = response.status === 200;
    console.log(`Smoke test result: ${passed ? 'PASSED' : 'FAILED'} (status: ${response.status})`);

    return {
      passed,
      status: response.status,
      body: responseBody,
    };
  } catch (error) {
    console.error('Smoke test error:', error);
    return {
      passed: false,
      error: error.message,
    };
  }
}

async function mergeBranchToProduction(branchId: string): Promise<any> {
  console.log(`Merging branch ${branchId} to production`);
  const result = await callManagementAPI(
    `/branches/${branchId}/merge`,
    'POST'
  );
  return result;
}

async function deleteBranch(branchId: string): Promise<void> {
  console.log(`Deleting branch ${branchId}`);
  await callManagementAPI(
    `/branches/${branchId}`,
    'DELETE'
  );
}

async function executeWorkflow(deployRequest: DeployRequest, apikey?: string): Promise<WorkflowResponse> {
  const branchName = `staging-${deployRequest.functionSlug}-${Date.now()}`;
  let branchId: string | undefined;
  let branchRef: string | undefined;
  let phase = 'init';

  try {
    phase = 'create_branch';
    const branch = await createBranch(branchName);
    branchId = branch.id;
    branchRef = branch.ref;
    console.log(`Branch created: ${branchId} (ref: ${branchRef})`);

    phase = 'wait_branch_ready';
    await waitForBranchReady(branchId);

    phase = 'deploy';
    const deploymentResult = await deployToStagingBranch(branchRef, deployRequest);
    console.log('Deployment successful:', deploymentResult);

    phase = 'smoke_test';
    const smokeTestResult = await runSmokeTest(branchRef, deployRequest.functionSlug, apikey);

    if (!smokeTestResult.passed) {
      phase = 'cleanup_failed';
      await deleteBranch(branchId);

      return {
        success: false,
        branchId,
        branchRef,
        deploymentResult,
        smokeTestResult,
        error: `Smoke test failed: status ${smokeTestResult.status || 'unknown'}`,
        phase,
        cleanup: true,
      };
    }

    phase = 'merge';
    const mergeResult = await mergeBranchToProduction(branchId);
    console.log('Merge successful:', mergeResult);

    phase = 'cleanup_success';
    await deleteBranch(branchId);

    return {
      success: true,
      branchId,
      branchRef,
      deploymentResult,
      smokeTestResult,
      mergeResult,
      phase,
      cleanup: true,
    };

  } catch (error) {
    console.error(`Error in phase ${phase}:`, error);

    if (branchId) {
      try {
        await deleteBranch(branchId);
        console.log('Branch cleaned up after error');
      } catch (cleanupError) {
        console.error('Failed to cleanup branch:', cleanupError);
      }
    }

    return {
      success: false,
      branchId,
      branchRef,
      error: error.message,
      phase,
      cleanup: !!branchId,
    };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing Authorization header' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (!SUPABASE_ACCESS_TOKEN) {
      throw new Error('SUPABASE_ACCESS_TOKEN environment variable not set');
    }

    const deployRequest: DeployRequest = await req.json();

    if (!deployRequest.functionName || !deployRequest.functionSlug || !deployRequest.sourceCode) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: functionName, functionSlug, sourceCode' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const apikey = req.headers.get('apikey') || authHeader.replace('Bearer ', '');

    console.log(`Starting staging workflow for function: ${deployRequest.functionSlug}`);
    const result = await executeWorkflow(deployRequest, apikey);

    return new Response(
      JSON.stringify(result),
      {
        status: result.success ? 200 : 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );

  } catch (error) {
    console.error('Workflow error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message,
        phase: 'request_handling',
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  }
});
