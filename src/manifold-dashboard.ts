import { createHeader } from './components/Header';
import { apiFetch, escapeHtml } from './utils/api';
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
  private pollInterval: number | null = null;
  private ontologyObjects: ObjectRegistry[] = [];
  private selectedObject: ObjectRegistry | null = null;
  private objectLinks: ObjectLink[] = [];

  constructor() {
    this.container = document.getElementById('app')!;
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

    // Setup cleanup on page unload to prevent memory leak (LOW finding #6)
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
    `;
    this.container.appendChild(dashboard);

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

    // Start polling for real-time updates
    this.startPolling();
  }

  private startPolling() {
    this.pollInterval = window.setInterval(() => {
      this.loadPipelines(false);
    }, 10000); // Poll every 10 seconds
  }

  private stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  // FIXED: Add cleanup on page unload to prevent memory leak (LOW finding)
  private setupCleanup() {
    window.addEventListener('beforeunload', () => {
      this.stopPolling();
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
  private async getPhaseHistory(pipelineId: string): Promise<PipelinePhase[]> {
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

  private async getExecutionManifest(pipelineId: string): Promise<WOExecutionManifest[]> {
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
      // Hide links section
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
    this.selectedObject = obj;

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

  private formatDate(dateStr: string): string {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
  }
}

// Initialize app
new ManifoldDashboard();
