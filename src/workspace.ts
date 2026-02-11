import { createHeader } from './components/Header';
import { createScorecardWidget } from './components/ScorecardWidget';
import { openWODetail } from './components/WODetailPanel';
import { apiFetch, escapeHtml } from './utils/api';
import type { WorkOrder, ContextData } from './types';
import './styles/tokens.css';
import './styles/reset.css';
import './styles/workspace.css';
import './styles/wo-detail.css';

interface Column {
  id: string;
  title: string;
  statuses: WorkOrder['status'][];
}

const columns: Column[] = [
  { id: 'inbox', title: 'Inbox', statuses: ['draft', 'ready'] },
  { id: 'progress', title: 'In Progress', statuses: ['pending_approval', 'in_progress'] },
  { id: 'review', title: 'Review', statuses: ['review', 'blocked'] },
  { id: 'done', title: 'Done', statuses: ['done'] },
];

class WorkspaceApp {
  private container: HTMLElement;
  private workOrders: WorkOrder[] = [];
  private projects: ContextData['projects'] = [];

  constructor() {
    this.container = document.getElementById('app')!;
    this.init();
  }

  private async init() {
    this.container.innerHTML = '';

    // Add header
    const header = createHeader('workspace');
    this.container.appendChild(header);

    // Create workspace layout
    const workspace = document.createElement('div');
    workspace.className = 'workspace';

    // Sidebar
    const sidebar = this.createSidebar();
    workspace.appendChild(sidebar);

    // Main board
    const boardContainer = document.createElement('div');
    boardContainer.className = 'board-container';

    const boardHeader = document.createElement('div');
    boardHeader.className = 'board-header';
    boardHeader.innerHTML = `
      <h1>Workspace</h1>
      <div class="board-actions">
        <span class="status-indicator">
          <span class="status-dot"></span>
          <span>Live</span>
        </span>
      </div>
    `;
    boardContainer.appendChild(boardHeader);

    const board = document.createElement('div');
    board.className = 'board';
    board.id = 'kanban-board';
    boardContainer.appendChild(board);

    workspace.appendChild(boardContainer);
    this.container.appendChild(workspace);

    // Load data
    await this.loadData();
  }

  private createSidebar(): HTMLElement {
    const sidebar = document.createElement('aside');
    sidebar.className = 'sidebar';
    sidebar.innerHTML = `
      <div class="sidebar-section">
        <h3>Projects</h3>
        <div id="project-list" class="project-list">
          <div class="loading-text">Loading...</div>
        </div>
      </div>
      <div class="sidebar-section">
        <h3>Quick Stats</h3>
        <div id="quick-stats" class="quick-stats">
          <div class="stat-item">
            <span class="stat-label">Active WOs</span>
            <span class="stat-value" id="stat-active">-</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Blocked</span>
            <span class="stat-value" id="stat-blocked">-</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Completed</span>
            <span class="stat-value" id="stat-done">-</span>
          </div>
        </div>
      </div>
    `;

    // Add scorecard widget
    const scorecardSection = document.createElement('div');
    scorecardSection.className = 'sidebar-section';
    const scorecardWidget = createScorecardWidget();
    scorecardSection.appendChild(scorecardWidget);
    sidebar.appendChild(scorecardSection);

    return sidebar;
  }

  private async loadData() {
    try {
      const [contextData, woData] = await Promise.all([
        apiFetch<ContextData>('/functions/v1/context-load', 'POST', { project_code: 'METIS-001' }),
        apiFetch<{ data: WorkOrder[] }>('/rest/v1/work_orders?select=*,qa_checklist,parent_id,depends_on,acceptance_criteria,objective,summary&order=updated_at.desc&limit=50')
      ]);

      this.workOrders = woData.data || contextData.work_orders || [];
      this.projects = contextData.projects || [];

      this.renderProjects();
      this.renderBoard();
      this.updateStats();
    } catch (error) {
      console.error('Failed to load data:', error);
      this.showError('Failed to load workspace data');
    }
  }

  private renderProjects() {
    const projectList = document.getElementById('project-list');
    if (!projectList || !this.projects) return;

    if (!this.projects.length) {
      projectList.innerHTML = '<div class="empty-text">No projects</div>';
      return;
    }

    projectList.innerHTML = this.projects.map(p => `
      <div class="project-item">
        <div class="project-name">${escapeHtml(p.name)}</div>
        <div class="project-meta">${p.code} &middot; ${p.completion_pct || 0}%</div>
      </div>
    `).join('');
  }

  private renderBoard_PLACEHOLDER() {
    // PLACEHOLDER - remove after edit
  }

  /* END_FIX */
  private renderBoard_ORIGINAL_BELOW() { ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ· ${p.completion_pct || 0}%</div>
      </div>
    `).join('');
  }

  private renderBoard() {
    const board = document.getElementById('kanban-board');
    if (!board) return;

    board.innerHTML = columns.map(col => this.renderColumn(col)).join('');

    // Click handler on WO cards â delegate from board
    board.addEventListener('click', (e) => {
      const card = (e.target as HTMLElement).closest('[data-wo-id]') as HTMLElement | null;
      if (card) {
        const woId = card.dataset.woId;
        if (woId) {
          openWODetail(woId, this.workOrders);
        }
      }
    });
  }

  private renderColumn(column: Column): string {
    const cards = this.workOrders.filter(wo =>
      column.statuses.includes(wo.status)
    );

    return `
      <div class="column" data-column="${column.id}">
        <div class="column-header">
          <h3>${column.title}</h3>
          <span class="column-count">${cards.length}</span>
        </div>
        <div class="column-content">
          ${cards.map(wo => this.renderCard(wo)).join('')}
        </div>
      </div>
    `;
  }

  private renderCard(wo: WorkOrder): string {
    const priorityClass = wo.priority?.replace('_', '-') || 'medium';
    const statusClass = wo.status.replace('_', '-');

    return `
      <div class="card" data-wo-id="${wo.id}">
        <div class="card-header">
          <span class="card-slug">${escapeHtml(wo.slug)}</span>
          <span class="card-priority ${priorityClass}"></span>
        </div>
        <div class="card-title">${escapeHtml(wo.name || 'Untitled')}</div>
        ${wo.summary ? `<div class="card-summary">${escapeHtml(wo.summary)}</div>` : ''}
        <div class="card-footer">
          <span class="card-status ${statusClass}">${wo.status.replace('_', ' ')}</span>
          ${wo.assigned_to ? `<span class="card-assignee">${escapeHtml(wo.assigned_to)}</span>` : ''}
        </div>
      </div>
    `;
  }

  private updateStats() {
    const active = this.workOrders.filter(wo =>
      ['pending_approval', 'in_progress'].includes(wo.status)
    ).length;
    const blocked = this.workOrders.filter(wo => wo.status === 'blocked').length;
    const done = this.workOrders.filter(wo => wo.status === 'done').length;

    const statActive = document.getElementById('stat-active');
    const statBlocked = document.getElementById('stat-blocked');
    const statDone = document.getElementById('stat-done');

    if (statActive) statActive.textContent = String(active);
    if (statBlocked) statBlocked.textContent = String(blocked);
    if (statDone) statDone.textContent = String(done);
  }

  private showError(message: string) {
    const board = document.getElementById('kanban-board');
    if (board) {
      board.innerHTML = `<div class="error-message">${escapeHtml(message)}</div>`;
    }
  }
}

// Initialize app
new WorkspaceApp();
