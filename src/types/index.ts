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
  qa_checklist: any[];
  parent_id: string | null;
  depends_on: string[] | null;
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
  finding_type: string;
  category: string;
  description: string;
  evidence: any;
  created_at: string;
}

export interface Project {
  id: string;
  code: string;
  name: string;
  status: string;
  summary?: string;
  current_phase?: number;
  completion_pct?: number;
  repo_url?: string;
  docs_url?: string;
  api_url?: string;
}

export interface Agent {
  id: string;
  name: string;
  agent_type: string;
  status: string;
  description?: string;
}

export interface ContextData {
  agents?: Agent[];
  work_orders?: WorkOrder[];
  projects?: Project[];
  phase_status?: {
    current_phase?: number;
    completion_pct?: number;
    phases?: Record<string, any>;
  };
  daemon_status?: {
    status: string;
    last_heartbeat?: string;
  };
  summary?: {
    blocked_work_orders?: number;
    draft_work_orders?: number;
  };
  recent_completions?: WorkOrder[];
  lesson_stats?: {
    total?: number;
  };
  directive_count?: number;
}

export interface ApiResponse<T> {
  data?: T;
  error?: string;
}
