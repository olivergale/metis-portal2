import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Notion database IDs (from your workspace)
const NOTION_DATABASES = {
  work_orders: 'b31a8893107d4f228e6aa3ab5bf19206',
  implementations: '4ee8f261a6044490a5bf1aa865b6b0d5',
  audits: '30c156c4396b457a82bfe1c1ef36ed24',
};

// Map Supabase enums to Notion select values
const STATUS_MAP: Record<string, string> = {
  draft: 'New',
  ready: 'New',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  review: 'Review',
  done: 'Done',
  cancelled: 'Cancelled',
};

const PRIORITY_MAP: Record<string, string> = {
  p0_critical: 'P0 - Critical',
  p1_high: 'P1 - High',
  p2_medium: 'P2 - Medium',
  p3_low: 'P3 - Low',
};

const COMPLEXITY_MAP: Record<string, string> = {
  trivial: 'Trivial',
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
  unknown: 'Unknown',
};

const OWNER_MAP: Record<string, string> = {
  you: 'You',
  engineering: 'Engineering Agent',
  audit: 'Audit Agent',
  cto: 'CTO',
  cpo: 'CPO',
  research: 'Research Agent',
  analysis: 'Analysis Agent',
  external: 'External',
};

const IMPL_STATUS_MAP: Record<string, string> = {
  started: 'Started',
  testing: 'Testing',
  failed: 'Failed',
  succeeded: 'Succeeded',
  deployed_staging: 'Deployed Staging',
  deployed_prod: 'Deployed Prod',
  rolled_back: 'Rolled Back',
};

const AUDIT_TYPE_MAP: Record<string, string> = {
  scheduled: 'Scheduled',
  post_deploy: 'Post-Deploy',
  incident: 'Incident',
  manual: 'Manual',
};

const SEVERITY_MAP: Record<string, string> = {
  info: 'Info',
  warning: 'Warning',
  error: 'Error',
  critical: 'Critical',
};

async function notionRequest(endpoint: string, method: string, body?: any) {
  const NOTION_API_KEY = Deno.env.get('NOTION_API_KEY');
  if (!NOTION_API_KEY) {
    throw new Error('NOTION_API_KEY not configured');
  }

  const response = await fetch(`https://api.notion.com/v1${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${NOTION_API_KEY}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Notion API error: ${response.status} ${error}`);
  }

  return response.json();
}

// Sync a work order to Notion
async function syncWorkOrder(record: any) {
  const properties: any = {
    Name: { title: [{ text: { content: record.name || 'Untitled' } }] },
    Status: { select: { name: STATUS_MAP[record.status] || 'New' } },
    Priority: { select: { name: PRIORITY_MAP[record.priority] || 'P2 - Medium' } },
    Summary: { rich_text: [{ text: { content: record.summary || '' } }] },
    Objective: { rich_text: [{ text: { content: record.objective || '' } }] },
    Constraints: { rich_text: [{ text: { content: record.constraints || '' } }] },
    'Acceptance Criteria': { rich_text: [{ text: { content: record.acceptance_criteria || '' } }] },
    'Escalation Conditions': { rich_text: [{ text: { content: record.escalation_conditions || '' } }] },
    'Supabase ID': { rich_text: [{ text: { content: record.id } }] },
  };

  if (record.assigned_to) {
    properties.Owner = { select: { name: OWNER_MAP[record.assigned_to] || 'You' } };
  }

  if (record.complexity) {
    properties.Complexity = { select: { name: COMPLEXITY_MAP[record.complexity] || 'Unknown' } };
  }

  if (record.max_iterations) {
    properties['Max Iterations'] = { number: record.max_iterations };
  }

  if (record.notion_page_id) {
    // Update existing page
    await notionRequest(`/pages/${record.notion_page_id}`, 'PATCH', { properties });
    return record.notion_page_id;
  } else {
    // Create new page
    const result = await notionRequest('/pages', 'POST', {
      parent: { database_id: NOTION_DATABASES.work_orders },
      properties,
    });
    return result.id;
  }
}

// Sync an implementation to Notion
async function syncImplementation(record: any) {
  const properties: any = {
    Name: { title: [{ text: { content: `Impl: ${record.branch_name || record.id.slice(0, 8)}` } }] },
    Status: { select: { name: IMPL_STATUS_MAP[record.status] || 'Started' } },
    'Branch Name': { rich_text: [{ text: { content: record.branch_name || '' } }] },
    'Commit SHAs': { rich_text: [{ text: { content: (record.commit_shas || []).join(', ') } }] },
    'Approach Taken': { rich_text: [{ text: { content: record.approach_taken || '' } }] },
    'Blockers Encountered': { rich_text: [{ text: { content: (record.blockers_encountered || []).join(', ') } }] },
    'Escalation Reason': { rich_text: [{ text: { content: record.escalation_reason || '' } }] },
    'Supabase ID': { rich_text: [{ text: { content: record.id } }] },
    Iterations: { number: record.iterations || 0 },
  };

  if (record.pr_url) {
    properties['PR URL'] = { url: record.pr_url };
  }

  if (record.deployment_url) {
    properties['Deployment URL'] = { url: record.deployment_url };
  }

  if (record.test_results) {
    properties['Test Results'] = { rich_text: [{ text: { content: JSON.stringify(record.test_results).slice(0, 2000) } }] };
  }

  if (record.notion_page_id) {
    await notionRequest(`/pages/${record.notion_page_id}`, 'PATCH', { properties });
    return record.notion_page_id;
  } else {
    const result = await notionRequest('/pages', 'POST', {
      parent: { database_id: NOTION_DATABASES.implementations },
      properties,
    });
    return result.id;
  }
}

// Sync an audit to Notion
async function syncAudit(record: any) {
  const properties: any = {
    Name: { title: [{ text: { content: record.name || 'Untitled Audit' } }] },
    'Audit Type': { select: { name: AUDIT_TYPE_MAP[record.audit_type] || 'Manual' } },
    Severity: { select: { name: SEVERITY_MAP[record.severity] || 'Info' } },
    Passed: { checkbox: record.passed },
    Summary: { rich_text: [{ text: { content: record.summary || '' } }] },
    'Supabase ID': { rich_text: [{ text: { content: record.id } }] },
  };

  if (record.findings) {
    properties.Findings = { rich_text: [{ text: { content: JSON.stringify(record.findings).slice(0, 2000) } }] };
  }

  if (record.recommendations) {
    properties.Recommendations = { rich_text: [{ text: { content: JSON.stringify(record.recommendations).slice(0, 2000) } }] };
  }

  if (record.cve_ids && record.cve_ids.length > 0) {
    properties['CVE IDs'] = { rich_text: [{ text: { content: record.cve_ids.join(', ') } }] };
  }

  if (record.notion_page_id) {
    await notionRequest(`/pages/${record.notion_page_id}`, 'PATCH', { properties });
    return record.notion_page_id;
  } else {
    const result = await notionRequest('/pages', 'POST', {
      parent: { database_id: NOTION_DATABASES.audits },
      properties,
    });
    return result.id;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { table, record, type } = await req.json();

    if (!table || !record) {
      return new Response(
        JSON.stringify({ error: 'Missing table or record' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    let notionPageId: string;

    switch (table) {
      case 'work_orders':
        notionPageId = await syncWorkOrder(record);
        await supabase
          .from('work_orders')
          .update({ notion_page_id: notionPageId, notion_synced_at: new Date().toISOString() })
          .eq('id', record.id);
        break;

      case 'implementations':
        notionPageId = await syncImplementation(record);
        await supabase
          .from('implementations')
          .update({ notion_page_id: notionPageId, notion_synced_at: new Date().toISOString() })
          .eq('id', record.id);
        break;

      case 'audits':
        notionPageId = await syncAudit(record);
        await supabase
          .from('audits')
          .update({ notion_page_id: notionPageId, notion_synced_at: new Date().toISOString() })
          .eq('id', record.id);
        break;

      default:
        return new Response(
          JSON.stringify({ error: `Unknown table: ${table}` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }

    return new Response(
      JSON.stringify({ success: true, notion_page_id: notionPageId }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Sync error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
