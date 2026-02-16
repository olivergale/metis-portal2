import { createHeader } from './components/Header';
import { apiFetch, escapeHtml } from './utils/api';
import { subscribeToManifoldChanges, unsubscribeAll } from './utils/realtime';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { WorkOrder } from './types';
import './styles/tokens.css';
import './styles/reset.css';
import './styles/workspace.css';

interface PipelineRun {
  id: string;
  current_phase: string;
  status: string;
  target: string;
  description: string;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

interface PipelinePhase {
  phase: string;
  wo_id: string;
  completed_at?: string;
}

interface ScaffoldContract {
  id: string;
  object_name: string;
  operation_type: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  preconditions: Record<string, unknown>;
  postconditions: Record<string, unknown>;
}

interface WOExecutionManifest {
  work_order_id: string;
  ac_number: number;
  step_order: number;
  expected_tool: string;
  expected_action: string;
  expected_object_type: string;
  required: boolean;
}

interface PipelineStats {
  total: number;
  active: number;
  completed: number;
  failed: number;
}

interface OntologySummary {
  total_objects: number;
  objects_with_properties: number;
  total_links: number;
}

interface DashboardData {
  pipeline_runs: PipelineRun[];
  ontology_summary: OntologySummary;
}

interface ActivityEvent {
  id: string;
  timestamp: string;
  table: string;
  eventType: string;
  summary: string;
}

interface ObjectRegistry {
  id: string;
  object_name: string;
  object_type: string;
  parent_id?: string;
  parent_name?: string;
  properties?: Record<string, unknown>;
}

interface ObjectLink {
  source_id: string;
  source_name: string;
  link_type: string;
  target_id: string;
  target_name: string;
  metadata?: Record<string, unknown>;
}

class ManifoldDashboard {
  private container: HTMLElement;
  private pipelines: PipelineRun[] = [];
  private selectedPipeline: PipelineRun | null = null;
  private manifest: WOExecutionManifest[] = [];
  private contracts: ScaffoldContract[] = [];
  private channels: RealtimeChannel[] = [];
  private activityEvents: ActivityEvent[] = [];
  private maxActivityEvents = 100;
  private ontologyObjects: ObjectRegistry[] = [];
  private _selectedObject: ObjectRegistry | null = null;
  private objectLinks: ObjectLink[] = [];

  constructor() {
    this.container = document.getElementById('app')!;
    void this._selectedObject;
    void this._getPhaseHistory;
    void this._getExecutionManifest;
    this.init();
  }

  private async init() {
    this.container.innerHTML = '';

    // Add header with back button
    const header = createHeader('manifold');
    const backBtn = header.querySelector('.header-nav');
    if (backBtn) {
      backBtn.innerHTML = `
        <a href="/workspace" class="nav-link">← Back to Workspace</a>
      `;
    }
    this.container.appendChild(header);

    // Setup cleanup on page unload
    this.setupCleanup();

    // Create dashboard layout
    const dashboard = document.createElement('div');
    dashboard.className = 'manifold-dashboard';
    dashboard.innerHTML = `
      <div class="manifold-header">
        <h1>Pipeline Control Center</h1>
        <div class="manifold-actions">
          <button id="refresh-btn" class="btn btn-secondary">
            ↻ Refresh
          </button>
          <button id="create-pipeline-btn" class="btn btn-primary">
            + New Pipeline
          </button>
        </div>
      </div>
      
      <div class="manifold-stats" id="manifold-stats">
        <div class="stat-card">
          <div class="stat-value" id="stat-total">-</div>
          <div class="stat-label">Total Pipelines</div>
        </div>
        <div class="stat-card">
          <div class="stat-value status-active" id="stat-active">-</div>
          <div class="stat-label">Active</div>
        </div>
        <div class="stat-card">
          <div class="stat-value status-completed" id="stat-completed">-</div>
          <div class="stat-label">Completed</div>
        </div>
        <div class="stat-card">
          <div class="stat-value status-failed" id="stat-failed">-</div>
          <div class="stat-label">Failed</div>
        </div>
      </div>

      <div class="manifold-grid">
        <div class="manifold-sidebar">
          <h2>Active Pipelines</h2>
          <div id="pipeline-list" class="pipeline-list">
            <div class="loading-text">Loading pipelines...</div>
          </div>
        </div>
        
        <div class="manifold-main">
          <div id="pipeline-detail" class="pipeline-detail">
            <div class="empty-state">
              <p>Select a pipeline to view details</p>
            </div>
          </div>
        </div>
      </div>

      <div class="live-activity-feed">
        <h2>Live Activity Feed</h2>
        <div id="activity-feed-container" class="activity-feed-container">
          <div class="empty-text">Waiting for activity...</div>
        </div>
      </div>

      <div class="ontology-explorer" id="ontology-explorer">
        <h2>Ontology Explorer</h2>
        <div class="ontology-controls">
          <input 
            type="text" 
            id="ontology-search" 
            placeholder="Search by name..." 
            class="ontology-search-input"
          />
          <select id="ontology-type-filter" class="ontology-type-select">
            <option value="">All Types</option>
            <option value="table">table</option>
            <option value="view">view</option>
            <option value="function">function</option>
            <option value="trigger">trigger</option>
            <option value="index">index</option>
            <option value="policy">policy</option>
            <option value="column">column</option>
            <option value="constraint">constraint</option>
            <option value="type">type</option>
            <option value="extension">extension</option>
            <option value="other">other</option>
          </select>
        </div>
        <div id="ontology-results" class="ontology-results">
          <div class="empty-text">Enter search criteria or select a type to explore objects</div>
        </div>
        <div id="ontology-links" class="ontology-links" style="display: none;">
          <h3>Object Links</h3>
          <div id="ontology-links-content"></div>
        </div>
      </div>

      <div class="feedback-panels">
        <div class="feedback-panel" id="mutation-velocity-panel">
          <h2>Mutation Velocity (24h)</h2>
          <div id="mutation-velocity-chart" class="feedback-chart">
            <div class="loading-text">Loading mutation data...</div>
          </div>
        </div>

        <div class="feedback-panel" id="agent-performance-panel">
          <h2>Agent Performance (7d)</h2>
          <div id="agent-performance-table" class="feedback-table">
            <div class="loading-text">Loading agent data...</div>
          </div>
        </div>

        <div class="feedback-panel" id="ontology-health-panel">
          <h2>Ontology Health</h2>
          <div id="ontology-health-content" class="feedback-health">
            <div class="loading-text">Loading health data...</div>
          </div>
        </div>
      </div>
    `;
    this.container.appendChild(dashboard);

    // Add inline styles for activity feed
    const style = document.createElement('style');
    style.textContent = `
      .live-activity-feed {
        margin: 24px;
        background: var(--bg-surface);
        border-radius: 8px;
        padding: 20px;
      }
      .live-activity-feed h2 {
        font-size: 18px;
        font-weight: 600;
        color: var(--text-primary);
        margin-bottom: 16px;
      }
      .activity-feed-container {
        max-height: 400px;
        overflow-y: auto;
        background: var(--bg-elevated);
        border-radius: 6px;
        padding: 12px;
      }
      .activity-item {
        padding: 12px;
        border-bottom: 1px solid var(--border-default);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .activity-item:last-child {
        border-bottom: none;
      }
      .activity-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .activity-timestamp {
        font-size: 11px;
        color: var(--text-muted);
      }
      .activity-meta {
        display: flex;
        gap: 8px;
        align-items: center;
        font-size: 12px;
      }
      .activity-table {
        font-weight: 600;
        color: var(--accent);
      }
      .activity-event-type {
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
      }
      .activity-event-type.INSERT {
        background: rgba(40, 167, 69, 0.2);
        color: var(--status-done);
      }
      .activity-event-type.UPDATE {
        background: rgba(212, 165, 116, 0.2);
        color: var(--accent);
      }
      .activity-event-type.DELETE {
        background: rgba(220, 53, 69, 0.2);
        color: var(--status-error);
      }
      .activity-summary {
        font-size: 13px;
        color: var(--text-secondary);
        margin-top: 4px;
      }
      .manifold-grid {
        display: grid;
        grid-template-columns: 300px 1fr;
        gap: 24px;
        padding: 24px;
      }
      .manifold-sidebar {
        background: var(--bg-surface);
        border-radius: 8px;
        padding: 20px;
      }
      .manifold-sidebar h2 {
        font-size: 16px;
        font-weight: 600;
        color: var(--text-primary);
        margin-bottom: 16px;
      }
      .manifold-main {
        background: var(--bg-surface);
        border-radius: 8px;
        padding: 20px;
      }
      .manifold-stats {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 16px;
        padding: 24px;
      }
      .stat-card {
        background: var(--bg-surface);
        border-radius: 8px;
        padding: 20px;
        text-align: center;
      }
      .stat-value {
        font-size: 32px;
        font-weight: 700;
        color: var(--text-primary);
        margin-bottom: 8px;
      }
      .stat-label {
        font-size: 12px;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .manifold-header {
        padding: 24px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .manifold-header h1 {
        font-size: 24px;
        font-weight: 600;
        color: var(--text-primary);
      }
      .manifold-actions {
        display: flex;
        gap: 12px;
      }
      .pipeline-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .pipeline-card {
        padding: 12px;
        background: var(--bg-elevated);
        border-radius: 6px;
        cursor: pointer;
        border: 2px solid transparent;
        transition: all 0.15s;
      }
      .pipeline-card:hover {
        border-color: var(--accent);
      }
      .pipeline-card.selected {
        border-color: var(--accent);
        background: var(--bg-hover);
      }
      .pipeline-card-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
      }
      .pipeline-target {
        font-weight: 600;
        color: var(--text-primary);
      }
      .pipeline-status {
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 4px;
        font-weight: 600;
        text-transform: uppercase;
      }
      .pipeline-status.status-active {
        background: rgba(40, 167, 69, 0.2);
        color: var(--status-done);
      }
      .pipeline-status.status-completed {
        background: rgba(212, 165, 116, 0.2);
        color: var(--accent);
      }
      .pipeline-status.status-failed {
        background: rgba(220, 53, 69, 0.2);
        color: var(--status-error);
      }
      .pipeline-card-meta {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        color: var(--text-muted);
      }
      .pipeline-detail {
        display: flex;
        flex-direction: column;
        gap: 24px;
      }
      .empty-state {
        text-align: center;
        padding: 40px;
        color: var(--text-muted);
      }
      .pipeline-detail-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .pipeline-detail-header h2 {
        font-size: 20px;
        font-weight: 600;
        color: var(--text-primary);
      }
      .pipeline-badges {
        display: flex;
        gap: 8px;
      }
      .badge {
        padding: 4px 12px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 600;
      }
      .badge.status-active {
        background: rgba(40, 167, 69, 0.2);
        color: var(--status-done);
      }
      .badge.status-completed {
        background: rgba(212, 165, 116, 0.2);
        color: var(--accent);
      }
      .badge.status-failed {
        background: rgba(220, 53, 69, 0.2);
        color: var(--status-error);
      }
      .badge.phase {
        background: var(--bg-elevated);
        color: var(--text-primary);
      }
      .pipeline-description {
        font-size: 14px;
        color: var(--text-secondary);
        line-height: 1.6;
      }
      .pipeline-timeline h3,
      .pipeline-manifest h3,
      .pipeline-contracts h3,
      .pipeline-intervention h3 {
        font-size: 16px;
        font-weight: 600;
        color: var(--text-primary);
        margin-bottom: 16px;
      }
      .phase-track {
        display: flex;
        gap: 12px;
        padding: 20px 0;
      }
      .phase-item {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        position: relative;
      }
      .phase-dot {
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: var(--bg-elevated);
        border: 2px solid var(--border-default);
      }
      .phase-item.completed .phase-dot {
        background: var(--status-done);
        border-color: var(--status-done);
      }
      .phase-item.current .phase-dot {
        background: var(--accent);
        border-color: var(--accent);
        box-shadow: 0 0 8px var(--accent);
      }
      .phase-label {
        font-size: 11px;
        color: var(--text-muted);
        text-transform: uppercase;
      }
      .phase-item.completed .phase-label {
        color: var(--status-done);
      }
      .phase-item.current .phase-label {
        color: var(--accent);
        font-weight: 600;
      }
      .manifest-list,
      .contracts-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .manifest-item {
        padding: 12px;
        background: var(--bg-elevated);
        border-radius: 6px;
        display: flex;
        gap: 12px;
        align-items: center;
        font-size: 12px;
      }
      .manifest-step {
        font-weight: 600;
        color: var(--text-muted);
        min-width: 60px;
      }
      .manifest-tool {
        font-family: var(--font-mono);
        color: var(--accent);
        min-width: 120px;
      }
      .manifest-action {
        color: var(--text-secondary);
        min-width: 100px;
      }
      .manifest-object {
        color: var(--text-muted);
      }
      .contract-item {
        padding: 16px;
        background: var(--bg-elevated);
        border-radius: 6px;
      }
      .contract-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
      }
      .contract-object {
        font-weight: 600;
        color: var(--text-primary);
      }
      .contract-operation {
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 4px;
        background: var(--bg-base);
        color: var(--accent);
        text-transform: uppercase;
      }
      .contract-meta {
        display: flex;
        gap: 8px;
        margin-bottom: 8px;
        font-size: 11px;
      }
      .contract-label {
        color: var(--text-muted);
        min-width: 100px;
      }
      .contract-value {
        color: var(--text-secondary);
        font-family: var(--font-mono);
        overflow-x: auto;
      }
      .intervention-actions {
        display: flex;
        gap: 12px;
      }
      .pipeline-timestamps {
        font-size: 12px;
        color: var(--text-muted);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .ontology-explorer {
        margin: 24px;
        background: var(--bg-surface);
        border-radius: 8px;
        padding: 20px;
      }
      .ontology-explorer h2 {
        font-size: 18px;
        font-weight: 600;
        color: var(--text-primary);
        margin-bottom: 16px;
      }
      .ontology-controls {
        display: flex;
        gap: 12px;
        margin-bottom: 16px;
      }
      .ontology-search-input {
        flex: 1;
        padding: 8px 12px;
        background: var(--bg-elevated);
        border: 1px solid var(--border-default);
        border-radius: 6px;
        color: var(--text-primary);
        font-size: 14px;
      }
      .ontology-type-select {
        padding: 8px 12px;
        background: var(--bg-elevated);
        border: 1px solid var(--border-default);
        border-radius: 6px;
        color: var(--text-primary);
        font-size: 14px;
        min-width: 150px;
      }
      .ontology-results {
        background: var(--bg-elevated);
        border-radius: 6px;
        padding: 12px;
      }
      .ontology-table {
        width: 100%;
        border-collapse: collapse;
      }
      .ontology-table th {
        text-align: left;
        padding: 12px;
        font-size: 12px;
        font-weight: 600;
        color: var(--text-muted);
        text-transform: uppercase;
        border-bottom: 2px solid var(--border-default);
      }
      .ontology-table td {
        padding: 12px;
        font-size: 14px;
        color: var(--text-secondary);
        border-bottom: 1px solid var(--border-default);
      }
      .ontology-row {
        cursor: pointer;
        transition: background 0.15s;
      }
      .ontology-row:hover {
        background: var(--bg-hover);
      }
      .ontology-row.selected {
        background: var(--bg-hover);
        border-left: 3px solid var(--accent);
      }
      .ontology-name {
        font-weight: 600;
        color: var(--text-primary);
      }
      .ontology-type {
        font-family: var(--font-mono);
        color: var(--accent);
        font-size: 12px;
      }
      .ontology-links {
        margin-top: 24px;
        padding: 16px;
        background: var(--bg-elevated);
        border-radius: 6px;
      }
      .ontology-links h3 {
        font-size: 16px;
        font-weight: 600;
        color: var(--text-primary);
        margin-bottom: 12px;
      }
      .links-table {
        width: 100%;
        border-collapse: collapse;
      }
      .links-table th {
        text-align: left;
        padding: 8px;
        font-size: 11px;
        font-weight: 600;
        color: var(--text-muted);
        text-transform: uppercase;
        border-bottom: 2px solid var(--border-default);
      }
      .links-table td {
        padding: 8px;
        font-size: 13px;
        color: var(--text-secondary);
        border-bottom: 1px solid var(--border-default);
      }
      .link-type {
        font-family: var(--font-mono);
        color: var(--accent);
        font-size: 11px;
      }
      .feedback-panels {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 20px;
        margin: 24px;
      }
      .feedback-panel {
        background: var(--bg-surface);
        border-radius: 8px;
        padding: 20px;
      }
      .feedback-panel h2 {
        font-size: 16px;
        font-weight: 600;
        color: var(--text-primary);
        margin-bottom: 16px;
      }
      .feedback-panel:first-child {
        grid-column: 1 / -1;
      }
      .feedback-chart {
        min-height: 160px;
      }
      .velocity-bars {
        display: flex;
        align-items: flex-end;
        gap: 4px;
        height: 140px;
        padding-bottom: 24px;
        position: relative;
        border-bottom: 1px solid var(--border-default);
      }
      .velocity-bar-group {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        height: 100%;
        justify-content: flex-end;
        position: relative;
      }
      .velocity-bar {
        width: 100%;
        max-width: 32px;
        border-radius: 3px 3px 0 0;
        position: relative;
      }
      .velocity-bar.success {
        background: var(--status-success, #22c55e);
      }
      .velocity-bar.failure {
        background: var(--status-error, #ef4444);
        border-radius: 0;
      }
      .velocity-label {
        font-size: 9px;
        color: var(--text-muted);
        position: absolute;
        bottom: -20px;
        transform: rotate(-45deg);
        white-space: nowrap;
      }
      .velocity-count {
        font-size: 9px;
        color: var(--text-secondary);
        margin-bottom: 2px;
      }
      .velocity-legend {
        display: flex;
        gap: 16px;
        margin-top: 8px;
        justify-content: center;
      }
      .velocity-legend-item {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        color: var(--text-secondary);
      }
      .velocity-legend-dot {
        width: 8px;
        height: 8px;
        border-radius: 2px;
      }
      .agent-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      .agent-table th {
        text-align: left;
        padding: 8px 10px;
        border-bottom: 2px solid var(--border-default);
        font-weight: 600;
        color: var(--text-secondary);
        font-size: 11px;
        text-transform: uppercase;
      }
      .agent-table td {
        padding: 8px 10px;
        border-bottom: 1px solid var(--border-default);
        color: var(--text-primary);
      }
      .agent-table tr:last-child td {
        border-bottom: none;
      }
      .metric-good { color: var(--status-success, #22c55e); }
      .metric-warn { color: var(--status-warning, #f59e0b); }
      .metric-bad { color: var(--status-error, #ef4444); }
      .health-grid {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 12px;
      }
      .health-stat {
        text-align: center;
        padding: 16px;
        background: var(--bg-elevated);
        border-radius: 6px;
      }
      .health-stat-value {
        font-size: 28px;
        font-weight: 700;
        color: var(--text-primary);
      }
      .health-stat-label {
        font-size: 12px;
        color: var(--text-secondary);
        margin-top: 4px;
      }
    `;
    document.head.appendChild(style);

    // Event listeners
    document.getElementById('refresh-btn')?.addEventListener('click', () => this.loadPipelines());
    document.getElementById('create-pipeline-btn')?.addEventListener('click', () => this.showCreateModal());

    // Ontology Explorer event listeners
    const searchInput = document.getElementById('ontology-search') as HTMLInputElement;
    const typeFilter = document.getElementById('ontology-type-filter') as HTMLSelectElement;
    searchInput?.addEventListener('input', () => this.loadOntologyObjects());
    typeFilter?.addEventListener('change', () => this.loadOntologyObjects());

    // Load initial data
    await this.loadPipelines();
    this.loadMutationVelocity();
    this.loadAgentPerformance();
    this.loadOntologyHealth();

    // Setup realtime subscriptions instead of polling
    this.setupRealtimeSubscriptions();
  }

  private setupRealtimeSubscriptions() {
    this.channels = subscribeToManifoldChanges((table, payload) => {
      this.handleRealtimeUpdate(table, payload);
    });
  }

  private handleRealtimeUpdate(table: string, payload: any) {
    const eventType = payload.eventType || 'UNKNOWN';
    const timestamp = new Date().toISOString();
    
    // Generate summary based on table and event
    let summary = '';
    const record = payload.new || payload.old || {};
    
    if (table === 'work_orders') {
      const slug = record.slug || 'Unknown';
      const status = record.status || 'unknown';
      summary = eventType === 'INSERT' 
        ? `New work order ${slug}` 
        : eventType === 'UPDATE'
        ? `${slug} → ${status}`
        : `${slug} deleted`;
    } else if (table === 'wo_mutations') {
      const tool = record.tool_name || 'unknown';
      const action = record.action || 'unknown';
      summary = `${tool} → ${action}`;
    } else if (table === 'pipeline_runs') {
      const target = record.target || 'unknown';
      const phase = record.current_phase || 'unknown';
      summary = eventType === 'INSERT'
        ? `New pipeline: ${target}`
        : `${target} in ${phase} phase`;
    } else if (table === 'wo_events') {
      const eventName = record.event_name || 'unknown';
      summary = `Event: ${eventName}`;
    } else {
      summary = `${eventType} on ${table}`;
    }

    const event: ActivityEvent = {
      id: `${Date.now()}-${Math.random()}`,
      timestamp,
      table,
      eventType,
      summary
    };

    // Prepend to activity feed
    this.activityEvents.unshift(event);
    
    // Limit to max events
    if (this.activityEvents.length > this.maxActivityEvents) {
      this.activityEvents = this.activityEvents.slice(0, this.maxActivityEvents);
    }

    this.renderActivityFeed();

    // Refresh pipeline data if pipeline_runs or work_orders changed
    if (table === 'pipeline_runs' || table === 'work_orders') {
      this.loadPipelines(false);
    }
  }

  private renderActivityFeed() {
    const container = document.getElementById('activity-feed-container');
    if (!container) return;

    if (this.activityEvents.length === 0) {
      container.innerHTML = '<div class="empty-text">Waiting for activity...</div>';
      return;
    }

    container.innerHTML = this.activityEvents.map(event => {
      const time = new Date(event.timestamp).toLocaleTimeString([], { 
        hour: '2-digit', 
        minute: '2-digit',
        second: '2-digit'
      });
      
      return `
        <div class="activity-item">
          <div class="activity-header">
            <div class="activity-meta">
              <span class="activity-table">${escapeHtml(event.table)}</span>
              <span class="activity-event-type ${event.eventType}">${escapeHtml(event.eventType)}</span>
            </div>
            <span class="activity-timestamp">${time}</span>
          </div>
          <div class="activity-summary">${escapeHtml(event.summary)}</div>
        </div>
      `;
    }).join('');
  }

  private setupCleanup() {
    window.addEventListener('beforeunload', () => {
      unsubscribeAll(this.channels);
    });
  }

  private async loadPipelines(showLoading = true) {
    try {
      // AC8 FIX: Call get_manifold_dashboard() RPC for initial overview data
      const dashData = await apiFetch<DashboardData>(
        '/rest/v1/rpc/get_manifold_dashboard',
        'POST'
      );

      // Use dashboard data for pipelines and stats
      this.pipelines = dashData?.pipeline_runs || [];

      // Calculate stats from pipeline data
      const stats = {
        total: this.pipelines.length,
        active: this.pipelines.filter(p => p.status === 'active').length,
        completed: this.pipelines.filter(p => p.status === 'completed').length,
        failed: this.pipelines.filter(p => p.status === 'failed').length,
      };

      this.renderPipelineList();
      this.updateStats(stats);
    } catch (error) {
      console.error('Failed to load pipelines:', error);
      if (showLoading) {
        const list = document.getElementById('pipeline-list');
        if (list) list.innerHTML = '<div class="error-text">Failed to load pipelines</div>';
      }
    }
  }

  // FIXED: Add null safety check (MEDIUM finding #5)
  private updateStats(stats: PipelineStats | undefined | null) {
    if (!stats) {
      stats = { total: 0, active: 0, completed: 0, failed: 0 };
    }
    const statTotal = document.getElementById('stat-total');
    const statActive = document.getElementById('stat-active');
    const statCompleted = document.getElementById('stat-completed');
    const statFailed = document.getElementById('stat-failed');

    if (statTotal) statTotal.textContent = String(stats.total || 0);
    if (statActive) statActive.textContent = String(stats.active || 0);
    if (statCompleted) statCompleted.textContent = String(stats.completed || 0);
    if (statFailed) statFailed.textContent = String(stats.failed || 0);
  }

  private renderPipelineList() {
    const list = document.getElementById('pipeline-list');
    if (!list) return;

    if (!this.pipelines.length) {
      list.innerHTML = '<div class="empty-text">No pipelines found</div>';
      return;
    }

    list.innerHTML = this.pipelines.map(p => this.renderPipelineCard(p)).join('');

    // Add click handlers
    list.querySelectorAll('.pipeline-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = (card as HTMLElement).dataset.pipelineId;
        if (id) {
          const pipeline = this.pipelines.find(p => p.id === id);
          if (pipeline) this.selectPipeline(pipeline);
        }
      });
    });
  }

  // FIXED: Use escapeHtml for all user data to prevent XSS (HIGH finding #7)
  private renderPipelineCard(p: PipelineRun): string {
    const statusClass = p.status === 'active' ? 'status-active' : 
                        p.status === 'completed' ? 'status-completed' : 'status-failed';
    const phaseClass = p.current_phase || 'unknown';

    return `
      <div class="pipeline-card ${statusClass}" data-pipeline-id="${p.id}">
        <div class="pipeline-card-header">
          <span class="pipeline-target">${escapeHtml(p.target || 'Unknown')}</span>
          <span class="pipeline-status ${statusClass}">${escapeHtml(p.status)}</span>
        </div>
        <div class="pipeline-card-meta">
          <span class="pipeline-phase">Phase: ${escapeHtml(phaseClass)}</span>
          <span class="pipeline-date">${this.formatDate(p.updated_at)}</span>
        </div>
      </div>
    `;
  }

  private async selectPipeline(pipeline: PipelineRun) {
    this.selectedPipeline = pipeline;

    // Highlight selected in list
    document.querySelectorAll('.pipeline-card').forEach(card => {
      card.classList.toggle('selected', 
        (card as HTMLElement).dataset.pipelineId === pipeline.id);
    });

    const detail = document.getElementById('pipeline-detail');
    if (!detail) return;

    detail.innerHTML = '<div class="loading-text">Loading pipeline details...</div>';

    try {
      // FIXED: Use correct RPC endpoint (HIGH finding #3)
      const detailData = await apiFetch<any>(
        '/rest/v1/rpc/get_pipeline_detail',
        'POST',
        { p_pipeline_run_id: pipeline.id }
      );

      const p = detailData?.pipeline || pipeline;
      // AC4 FIX: Use phase_wos instead of phase_history
      const phases = detailData?.phase_wos || [];
      // AC4 FIX: Extract contracts from response
      this.contracts = detailData?.contracts || [];

      this.manifest = detailData?.manifest_steps || [];

      detail.innerHTML = this.renderPipelineDetail(p, phases);

      // Add intervention handlers
      this.attachInterventionHandlers(pipeline.id);
    } catch (error) {
      console.error('Failed to load pipeline detail:', error);
      detail.innerHTML = '<div class="error-text">Failed to load pipeline details</div>';
    }
  }

  // FIXED: Use correct endpoint for phase history (HIGH finding #3)
  private async _getPhaseHistory(pipelineId: string): Promise<PipelinePhase[]> {
    try {
      const result = await apiFetch<any>(
        '/rest/v1/rpc/get_pipeline_detail',
        'POST',
        { p_pipeline_run_id: pipelineId }
      );
      // AC4 FIX: Use phase_wos instead of phase_history
      return result?.phase_wos || [];
    } catch {
      return [];
    }
  }

  private async _getExecutionManifest(pipelineId: string): Promise<WOExecutionManifest[]> {
    try {
      // Find the scaffold WO for this pipeline
      const wos = await apiFetch<WorkOrder[]>(
        `/rest/v1/work_orders?pipeline_run_id=eq.${pipelineId}&select=id,slug,status,pipeline_phase`,
        'GET'
      );

      const scaffoldWo = wos?.find(wo => wo.pipeline_phase === 'scaffold');
      if (!scaffoldWo) return [];

      const manifest = await apiFetch<WOExecutionManifest[]>(
        `/rest/v1/wo_execution_manifest?work_order_id=eq.${scaffoldWo.id}&order=step_order`,
        'GET'
      );

      return manifest || [];
    } catch {
      return [];
    }
  }

  // FIXED: Use escapeHtml for all user data to prevent XSS (HIGH finding #7)
  // FIXED: Use current_phase instead of phase (CRITICAL finding #10)
  private renderPipelineDetail(p: PipelineRun, phases: PipelinePhase[]): string {
    const statusClass = p.status === 'active' ? 'status-active' : 
                        p.status === 'completed' ? 'status-completed' : 'status-failed';

    const allPhases = ['spec', 'plan', 'scaffold', 'build', 'verify', 'harden', 'integrate'];
    const completedPhases = phases.map(ph => ph.phase);
    const currentPhaseIndex = allPhases.indexOf(p.current_phase || '');

    return `
      <div class="pipeline-detail-header">
        <h2>${escapeHtml(p.target || 'Unknown Pipeline')}</h2>
        <div class="pipeline-badges">
          <span class="badge ${statusClass}">${escapeHtml(p.status)}</span>
          <span class="badge phase">${escapeHtml(p.current_phase || 'unknown')} phase</span>
        </div>
      </div>

      <div class="pipeline-description">
        ${escapeHtml(p.description || 'No description')}
      </div>

      <div class="pipeline-timeline">
        <h3>Phase Progress</h3>
        <div class="phase-track">
          ${allPhases.map((phase, index) => {
            const isCompleted = completedPhases.includes(phase);
            const isCurrent = index === currentPhaseIndex && p.status === 'active';
            const isPending = index > currentPhaseIndex;
            
            let phaseClass = 'phase-item';
            if (isCompleted) phaseClass += ' completed';
            if (isCurrent) phaseClass += ' current';
            if (isPending) phaseClass += ' pending';

            return `
              <div class="${phaseClass}">
                <div class="phase-dot"></div>
                <div class="phase-label">${escapeHtml(phase)}</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>

      <div class="pipeline-manifest">
        <h3>Execution Manifest (${this.manifest.length} steps)</h3>
        ${this.manifest.length ? `
          <div class="manifest-list">
            ${this.manifest.map(m => `
              <div class="manifest-item">
                <span class="manifest-step">Step ${m.step_order}</span>
                <span class="manifest-tool">${escapeHtml(m.expected_tool)}</span>
                <span class="manifest-action">${escapeHtml(m.expected_action)}</span>
                <span class="manifest-object">${escapeHtml(m.expected_object_type || '-')}</span>
              </div>
            `).join('')}
          </div>
        ` : '<div class="empty-text">No manifest steps recorded</div>'}
      </div>

      <div class="pipeline-contracts">
        <h3>Scaffold Contracts (${this.contracts.length})</h3>
        ${this.contracts.length ? `
          <div class="contracts-list">
            ${this.contracts.map(c => `
              <div class="contract-item">
                <div class="contract-header">
                  <span class="contract-object">${escapeHtml(c.object_name)}</span>
                  <span class="contract-operation">${escapeHtml(c.operation_type)}</span>
                </div>
                <div class="contract-meta">
                  <span class="contract-label">Preconditions:</span>
                  <span class="contract-value">${JSON.stringify(c.preconditions || {})}</span>
                </div>
                <div class="contract-meta">
                  <span class="contract-label">Postconditions:</span>
                  <span class="contract-value">${JSON.stringify(c.postconditions || {})}</span>
                </div>
              </div>
            `).join('')}
          </div>
        ` : '<div class="empty-text">No scaffold contracts</div>'}
      </div>

      <div class="pipeline-intervention">
        <h3>Intervene</h3>
        <div class="intervention-actions">
          <button class="btn btn-warning" data-action="pause">
            ⏸ Pause
          </button>
          <button class="btn btn-success" data-action="resume">
            ▶ Resume
          </button>
          <button class="btn btn-secondary" data-action="skip_phase">
            ⏭ Skip Phase
          </button>
          <button class="btn btn-secondary" data-action="restart_phase">
            ↻ Restart Phase
          </button>
        </div>
      </div>

      <div class="pipeline-timestamps">
        <div>Created: ${this.formatDate(p.created_at)}</div>
        <div>Updated: ${this.formatDate(p.updated_at)}</div>
        ${p.completed_at ? `<div>Completed: ${this.formatDate(p.completed_at)}</div>` : ''}
      </div>
    `;
  }

  private attachInterventionHandlers(pipelineId: string) {
    document.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const action = (e.target as HTMLElement).dataset.action;
        if (action) {
          await this.intervene(pipelineId, action);
        }
      });
    });
  }

  // INFO: CSRF handled by Supabase - edge functions require valid JWT
  private async intervene(pipelineId: string, action: string) {
    if (!confirm(`Are you sure you want to ${action.replace('_', ' ')} this pipeline?`)) {
      return;
    }

    try {
      // Use RPC instead of non-existent edge function
      await apiFetch(
        '/rest/v1/rpc/intervene_pipeline',
        'POST',
        { p_pipeline_run_id: pipelineId, p_action: action }
      );

      // Refresh to show updated state
      await this.loadPipelines();
      if (this.selectedPipeline?.id === pipelineId) {
        await this.selectPipeline(this.selectedPipeline);
      }
    } catch (error) {
      console.error('Intervention failed:', error);
      alert('Failed to perform intervention. Please try again.');
    }
  }

  private showCreateModal() {
    // Simple prompt for now - could be enhanced with a modal
    const target = prompt('Enter pipeline target (e.g., feature-name):');
    if (!target) return;

    const description = prompt('Enter pipeline description:') || '';
    this.createPipeline(target, description);
  }

  private async createPipeline(target: string, description: string) {
    try {
      // Use RPC instead of non-existent edge function
      await apiFetch(
        '/rest/v1/rpc/create_pipeline',
        'POST',
        { p_target: target, p_description: description }
      );

      await this.loadPipelines();
    } catch (error) {
      console.error('Failed to create pipeline:', error);
      alert('Failed to create pipeline. Please try again.');
    }
  }

  private formatDate(dateStr: string): string {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
  }

  private async loadOntologyObjects() {
    const searchInput = document.getElementById('ontology-search') as HTMLInputElement;
    const typeFilter = document.getElementById('ontology-type-filter') as HTMLSelectElement;
    const resultsContainer = document.getElementById('ontology-results');
    
    if (!resultsContainer) return;

    const searchText = searchInput?.value.trim() || '';
    const selectedType = typeFilter?.value || '';

    // Only search if there's a filter or search text
    if (!searchText && !selectedType) {
      resultsContainer.innerHTML = '<div class="empty-text">Enter search criteria or select a type to explore objects</div>';
      const linksSection = document.getElementById('ontology-links');
      if (linksSection) linksSection.style.display = 'none';
      return;
    }

    resultsContainer.innerHTML = '<div class="loading-text">Loading ontology objects...</div>';

    try {
      const results = await apiFetch<ObjectRegistry[]>(
        '/rest/v1/rpc/query_object_registry',
        'POST',
        {
          p_object_type: selectedType || null,
          p_name_pattern: searchText || null,
          p_limit: 50
        }
      );

      this.ontologyObjects = results || [];
      this.renderOntologyTable();
    } catch (error) {
      console.error('Failed to load ontology objects:', error);
      resultsContainer.innerHTML = '<div class="error-text">Failed to load ontology objects</div>';
    }
  }

  private renderOntologyTable() {
    const resultsContainer = document.getElementById('ontology-results');
    if (!resultsContainer) return;

    if (!this.ontologyObjects.length) {
      resultsContainer.innerHTML = '<div class="empty-text">No objects found</div>';
      return;
    }

    const tableHtml = `
      <table class="ontology-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Parent</th>
            <th>Properties</th>
          </tr>
        </thead>
        <tbody>
          ${this.ontologyObjects.map(obj => {
            const propsCount = obj.properties ? Object.keys(obj.properties).length : 0;
            return `
              <tr class="ontology-row" data-object-id="${obj.id}">
                <td class="ontology-name">${escapeHtml(obj.object_name)}</td>
                <td class="ontology-type">${escapeHtml(obj.object_type)}</td>
                <td class="ontology-parent">${obj.parent_name ? escapeHtml(obj.parent_name) : '-'}</td>
                <td class="ontology-props-count">${propsCount}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;

    resultsContainer.innerHTML = tableHtml;

    // Add click handlers for rows
    resultsContainer.querySelectorAll('.ontology-row').forEach(row => {
      row.addEventListener('click', () => {
        const objectId = (row as HTMLElement).dataset.objectId;
        if (objectId) {
          const obj = this.ontologyObjects.find(o => o.id === objectId);
          if (obj) this.selectObject(obj);
        }
      });
    });
  }

  private async selectObject(obj: ObjectRegistry) {
    this._selectedObject = obj;

    // Highlight selected row
    document.querySelectorAll('.ontology-row').forEach(row => {
      row.classList.toggle('selected', 
        (row as HTMLElement).dataset.objectId === obj.id);
    });

    const linksSection = document.getElementById('ontology-links');
    const linksContent = document.getElementById('ontology-links-content');
    
    if (!linksSection || !linksContent) return;

    linksSection.style.display = 'block';
    linksContent.innerHTML = '<div class="loading-text">Loading object links...</div>';

    try {
      const links = await apiFetch<ObjectLink[]>(
        '/rest/v1/rpc/query_object_links',
        'POST',
        {
          p_source_id: obj.id,
          p_limit: 20
        }
      );

      this.objectLinks = links || [];
      this.renderObjectLinks();
    } catch (error) {
      console.error('Failed to load object links:', error);
      linksContent.innerHTML = '<div class="error-text">Failed to load object links</div>';
    }
  }

  private renderObjectLinks() {
    const linksContent = document.getElementById('ontology-links-content');
    if (!linksContent) return;

    if (!this.objectLinks.length) {
      linksContent.innerHTML = '<div class="empty-text">No links found for this object</div>';
      return;
    }

    const tableHtml = `
      <table class="links-table">
        <thead>
          <tr>
            <th>Link Type</th>
            <th>Target</th>
          </tr>
        </thead>
        <tbody>
          ${this.objectLinks.map(link => `
            <tr class="link-row">
              <td class="link-type">${escapeHtml(link.link_type)}</td>
              <td class="link-target">${escapeHtml(link.target_name)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    linksContent.innerHTML = tableHtml;
  }

  private async loadMutationVelocity() {
    const container = document.getElementById('mutation-velocity-chart');
    if (!container) return;
    try {
      const data = await apiFetch<Array<{hour: string; total: number; success: number; failure: number}>>(
        '/rest/v1/rpc/get_mutation_velocity',
        'POST',
        { p_hours: 24 }
      );
      if (!data || !data.length) {
        container.innerHTML = '<div class="empty-text">No mutation data in the last 24 hours</div>';
        return;
      }
      const maxTotal = Math.max(...data.map(d => d.total), 1);
      const barsHtml = data.map(d => {
        const successPct = (d.success / maxTotal) * 100;
        const failurePct = (d.failure / maxTotal) * 100;
        const hour = new Date(d.hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `
          <div class="velocity-bar-group">
            <div class="velocity-count">${d.total}</div>
            <div class="velocity-bar failure" style="height: ${failurePct}%;" title="${d.failure} failures"></div>
            <div class="velocity-bar success" style="height: ${successPct}%;" title="${d.success} successes"></div>
            <span class="velocity-label">${escapeHtml(hour)}</span>
          </div>
        `;
      }).join('');

      container.innerHTML = `
        <div class="velocity-bars">${barsHtml}</div>
        <div class="velocity-legend">
          <div class="velocity-legend-item">
            <div class="velocity-legend-dot" style="background: var(--status-success, #22c55e);"></div>
            Success
          </div>
          <div class="velocity-legend-item">
            <div class="velocity-legend-dot" style="background: var(--status-error, #ef4444);"></div>
            Failure
          </div>
        </div>
      `;
    } catch (e) {
      console.error('Failed to load mutation velocity:', e);
      container.innerHTML = '<div class="error-text">Failed to load mutation data</div>';
    }
  }

  private async loadAgentPerformance() {
    const container = document.getElementById('agent-performance-table');
    if (!container) return;
    try {
      const data = await apiFetch<Array<{
        agent_name: string; wos_done: number; wos_failed: number;
        qa_pass_rate: number; mutation_success_rate: number; avg_completion_minutes: number;
      }>>('/rest/v1/rpc/get_agent_performance_summary', 'POST', { p_days: 7 });
      if (!data || !data.length) {
        container.innerHTML = '<div class="empty-text">No agent performance data</div>';
        return;
      }
      const rateClass = (v: number) => v >= 0.8 ? 'metric-good' : v >= 0.5 ? 'metric-warn' : 'metric-bad';
      const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
      const rows = data
        .filter(a => a.wos_done > 0)
        .sort((a, b) => b.wos_done - a.wos_done)
        .map(a => `
          <tr>
            <td><strong>${escapeHtml(a.agent_name)}</strong></td>
            <td>${a.wos_done}</td>
            <td>${a.wos_failed}</td>
            <td class="${rateClass(a.mutation_success_rate)}">${pct(a.mutation_success_rate)}</td>
            <td>${a.avg_completion_minutes.toFixed(1)}m</td>
          </tr>
        `).join('');

      container.innerHTML = `
        <table class="agent-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Done</th>
              <th>Failed</th>
              <th>Mutation Rate</th>
              <th>Avg Time</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `;
    } catch (e) {
      console.error('Failed to load agent performance:', e);
      container.innerHTML = '<div class="error-text">Failed to load agent data</div>';
    }
  }

  private async loadOntologyHealth() {
    const container = document.getElementById('ontology-health-content');
    if (!container) return;
    try {
      const data = await apiFetch<{total_objects: number; total_links: number; stale_count: number}>(
        '/rest/v1/rpc/get_ontology_health',
        'POST'
      );
      if (!data) {
        container.innerHTML = '<div class="empty-text">No ontology health data</div>';
        return;
      }
      container.innerHTML = `
        <div class="health-grid">
          <div class="health-stat">
            <div class="health-stat-value">${data.total_objects.toLocaleString()}</div>
            <div class="health-stat-label">Objects</div>
          </div>
          <div class="health-stat">
            <div class="health-stat-value">${data.total_links.toLocaleString()}</div>
            <div class="health-stat-label">Links</div>
          </div>
          <div class="health-stat">
            <div class="health-stat-value ${data.stale_count > 0 ? 'metric-warn' : 'metric-good'}">${data.stale_count}</div>
            <div class="health-stat-label">Stale</div>
          </div>
        </div>
      `;
    } catch (e) {
      console.error('Failed to load ontology health:', e);
      container.innerHTML = '<div class="error-text">Failed to load health data</div>';
    }
  }
}

// Initialize app
new ManifoldDashboard();
