import { createHeader } from './components/Header';
import { apiFetch, escapeHtml } from './utils/api';
import type { WorkOrder } from './types';
import './styles/tokens.css';
import './styles/reset.css';
import './styles/workspace.css';

interface PipelineRun {
  id: string;
  phase: string;
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

class ManifoldDashboard {
  private container: HTMLElement;
  private pipelines: PipelineRun[] = [];
  private selectedPipeline: PipelineRun | null = null;
  private manifest: WOExecutionManifest[] = [];
  private pollInterval: number | null = null;

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
    `;
    this.container.appendChild(dashboard);

    // Event listeners
    document.getElementById('refresh-btn')?.addEventListener('click', () => this.loadPipelines());
    document.getElementById('create-pipeline-btn')?.addEventListener('click', () => this.showCreateModal());

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

  private async loadPipelines(showLoading = true) {
    try {
      const data = await apiFetch<{ pipelines: PipelineRun[], stats: PipelineStats }>(
        '/functions/v1/get-manifold-dashboard',
        'POST',
        {}
      );

      this.pipelines = data.pipelines || [];
      this.renderPipelineList();
      this.updateStats(data.stats);
    } catch (error) {
      console.error('Failed to load pipelines:', error);
      if (showLoading) {
        const list = document.getElementById('pipeline-list');
        if (list) list.innerHTML = '<div class="error-text">Failed to load pipelines</div>';
      }
    }
  }

  private updateStats(stats: PipelineStats) {
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

  private renderPipelineCard(p: PipelineRun): string {
    const statusClass = p.status === 'active' ? 'status-active' : 
                        p.status === 'completed' ? 'status-completed' : 'status-failed';
    const phaseClass = p.phase || 'unknown';

    return `
      <div class="pipeline-card ${statusClass}" data-pipeline-id="${p.id}">
        <div class="pipeline-card-header">
          <span class="pipeline-target">${escapeHtml(p.target || 'Unknown')}</span>
          <span class="pipeline-status ${statusClass}">${p.status}</span>
        </div>
        <div class="pipeline-card-meta">
          <span class="pipeline-phase">Phase: ${phaseClass}</span>
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
      const [detailData, phaseHistory, manifestData] = await Promise.all([
        apiFetch<{ pipeline: PipelineRun }>(
          '/functions/v1/get-pipeline-detail',
          'POST',
          { p_pipeline_run_id: pipeline.id }
        ),
        this.getPhaseHistory(pipeline.id),
        this.getExecutionManifest(pipeline.id)
      ]);

      this.manifest = manifestData || [];

      const p = detailData.pipeline || pipeline;
      const phases = phaseHistory || [];

      detail.innerHTML = this.renderPipelineDetail(p, phases);

      // Add intervention handlers
      this.attachInterventionHandlers(pipeline.id);
    } catch (error) {
      console.error('Failed to load pipeline detail:', error);
      detail.innerHTML = '<div class="error-text">Failed to load pipeline details</div>';
    }
  }

  private async getPhaseHistory(pipelineId: string): Promise<PipelinePhase[]> {
    try {
      const result = await apiFetch<{ phase_history: PipelinePhase[] }>(
        '/rest/v1/rpc/get_pipeline_detail',
        'POST',
        { p_pipeline_run_id: pipelineId }
      );
      return result?.phase_history || [];
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

  private renderPipelineDetail(p: PipelineRun, phases: PipelinePhase[]): string {
    const statusClass = p.status === 'active' ? 'status-active' : 
                        p.status === 'completed' ? 'status-completed' : 'status-failed';

    const allPhases = ['spec', 'plan', 'scaffold', 'build', 'verify', 'harden', 'integrate'];
    const completedPhases = phases.map(ph => ph.phase);
    const currentPhaseIndex = allPhases.indexOf(p.phase || '');

    return `
      <div class="pipeline-detail-header">
        <h2>${escapeHtml(p.target || 'Unknown Pipeline')}</h2>
        <div class="pipeline-badges">
          <span class="badge ${statusClass}">${p.status}</span>
          <span class="badge phase">${p.phase || 'unknown'} phase</span>
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
                <div class="phase-label">${phase}</div>
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
                <span class="manifest-tool">${m.expected_tool}</span>
                <span class="manifest-action">${m.expected_action}</span>
                <span class="manifest-object">${m.expected_object_type || '-'}</span>
              </div>
            `).join('')}
          </div>
        ` : '<div class="empty-text">No manifest steps recorded</div>'}
      </div>

      <div class="pipeline-intervention">
        <h3>Intervene</h3>
        <div class="intervention-actions">
          <button class="btn btn-warning" data-action="pause">
            ⏸ Pause
          </button>
          <button class="btn btn-danger" data-action="abort">
            ⛔ Abort
          </button>
          <button class="btn btn-secondary" data-action="retry">
            ↻ Retry
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

  private async intervene(pipelineId: string, action: string) {
    if (!confirm(`Are you sure you want to ${action} this pipeline?`)) {
      return;
    }

    try {
      await apiFetch(
        '/functions/v1/intervene_pipeline',
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
      await apiFetch(
        '/functions/v1/create_pipeline',
        'POST',
        { target, description }
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
}

// Initialize app
new ManifoldDashboard();
