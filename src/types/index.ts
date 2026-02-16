export interface WorkOrder {
  id: string;
  slug: string;
  name: string;
  status: 'draft' | 'ready' | 'pending_approval' | 'in_progress' | 'blocked' | 'blocked_on_input' | 'review' | 'done' | 'cancelled' | 'failed';
  priority: 'p0_critical' | 'p1_high' | 'p2_medium' | 'p3_low';
  complexity?: string;
  summary?: string;
  objective?: string;
  acceptance_criteria?: string;
  assigned_to?: string;
  created_at?: string;
  updated_at?: string;
  started_at?: string;
  completed_at?: string;
  qa_checklist: QAChecklistItem[];
  parent_id: string | null;
  depends_on: string[] | null;
  pipeline_phase?: string | null;
  pipeline_run_id?: string | null;
  tags?: string[];
}

export interface QAChecklistItem {
  id?: string;
  criterion?: string;
  status?: 'pass' | 'fail' | 'pending';
  checklist_item_id?: string;
}

export interface ExecutionLogEntry {
  id: string;
  work_order_id: string;
  phase: string;
  agent_name: string;
  detail: any;
  created_at: string;
}

export interface QAFinding {
  id: string;
  work_order_id?: string;
  finding_type: string;
  category: string;
  description: string;
  evidence: any;
  created_at: string;
}

export interface WOEvent {
  id: string;
  work_order_id: string;
  event_type: string;
  previous_status: string | null;
  new_status: string | null;
  payload: any;
  actor: string;
  depth: number | null;
  status: string | null;
  created_at: string;
  processed_at: string | null;
}

export interface WOMutation {
  id: string;
  work_order_id: string;
  tool_name: string;
  action: string;
  target_object?: string;
  status?: 'success' | 'failure';
  success?: boolean;
  error_message?: string;
  error_class?: string;
  error_detail?: string;
  detail?: any;
  agent_name?: string;
  created_at: string;
}

export interface PipelineRun {
  id: string;
  current_phase: string;
  status: string;
  target: string;
  description: string;
  config: Record<string, unknown>;
  phase_history?: Array<{ phase: string; wo_id?: string; completed_at?: string }>;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export interface Agent {
  id: string;
  name: string;
  agent_type: string;
  status: string;
  description?: string;
  model?: string;
}

export interface AuditLogEntry {
  id: string;
  event_type: string;
  target_type: string;
  target_id: string;
  payload: any;
  created_at: string;
  agent_name?: string;
}

export interface Project {
  id: string;
  code: string;
  name: string;
  status: string;
  summary?: string;
  current_phase?: number;
  completion_pct?: number;
}

export interface HealthCheck {
  component: string;
  check: string;
  status: 'green' | 'yellow' | 'red';
  detail?: string;
  lastActivity?: string;
}

export type LogType = 'execution' | 'mutation' | 'event' | 'audit';

export interface UnifiedLogEntry {
  id: string;
  timestamp: string;
  source: LogType;
  agent?: string;
  woSlug?: string;
  woId?: string;
  pipelineId?: string;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  detail?: any;
}

export interface AgentStats {
  agent_name: string;
  wos_done: number;
  wos_failed: number;
  mutation_success_rate: number;
  avg_completion_minutes: number;
  last_mutation_at?: string;
  current_wo_slug?: string;
  current_wo_status?: string;
}
