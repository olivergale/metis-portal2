import { apiFetch, escapeHtml, relativeTime } from '../utils/api';
import type { WorkOrder, ExecutionLogEntry, QAFinding, WOEvent } from '../types';
import { renderActionButtons } from './WOActions';
import { loadWOEvents, setupAutoRefresh, clearAutoRefresh } from './WOEventsTimeline';

/**
 * Render WO Detail Panel — slide-out panel showing full execution trail,
 * QA checklist, and QA findings for a work order.
 */
export function renderWODetailPanel(wo: WorkOrder): HTMLElement {
  // Overlay
  const overlay = document.createElement('div');
  overlay.className = 'wo-detail-overlay';
  overlay.addEventListener('click', () => closePanel(overlay, panel));

  // Panel
  const panel = document.createElement('div');
  panel.className = 'wo-detail-panel';
  panel.addEventListener('click', (e) => e.stopPropagation());

  // Header
  const header = document.createElement('div');
  header.className = 'wo-detail-header';
  header.innerHTML = `
    <div class="wo-detail-header-left">
      <span class="wo-detail-slug">${escapeHtml(wo.slug)}</span>
      <span class="wo-detail-name">${escapeHtml(wo.name || 'Untitled')}</span>
      <div class="wo-detail-meta">
        <span class="badge badge-status ${wo.status}">${wo.status.replace(/_/g, ' ')}</span>
        <span class="badge badge-priority ${wo.priority}">${wo.priority.replace(/_/g, ' ')}</span>
        ${wo.assigned_to ? `<span style="font-size:12px;color:var(--text-muted)">Agent: ${escapeHtml(wo.assigned_to)}</span>` : ''}
      </div>
    </div>
    <button class="wo-detail-close" title="Close">&times;</button>
  `;
  header.querySelector('.wo-detail-close')!.addEventListener('click', () => closePanel(overlay, panel));
  panel.appendChild(header);

  // Content
  const content = document.createElement('div');
  content.className = 'wo-detail-content';

  // Action buttons
  const actionButtons = renderActionButtons(wo);
  if (actionButtons) {
    content.appendChild(actionButtons);
  }

  // Clarification Banner (if blocked_on_input)
  if (wo.status === 'blocked_on_input') {
    const clarificationBanner = renderClarificationBanner(wo.id);
    content.appendChild(clarificationBanner);
  }

  // Info Section
  content.appendChild(renderInfoSection(wo));

  // Execution Log (loaded async)
  const execSection = renderSectionShell('Execution Log', 'Loading...');
  content.appendChild(execSection);
  loadExecutionLog(wo.id, execSection);

  // WO Events Timeline (loaded async)
  const eventsSection = renderSectionShell('WO Events Timeline', 'Loading...');
  content.appendChild(eventsSection);
  loadWOEvents(wo.id, eventsSection);

  // Set up auto-refresh for in_progress WOs
  if (wo.status === 'in_progress') {
    setupAutoRefresh(wo.id, eventsSection);
  }

  // QA Checklist
  content.appendChild(renderQAChecklist(wo.qa_checklist));

  // QA Findings (loaded async)
  const findingsSection = renderSectionShell('QA Findings', 'Loading...');
  content.appendChild(findingsSection);
  loadQAFindings(wo.id, findingsSection);

  panel.appendChild(content);

  // Assemble
  const container = document.createElement('div');
  container.id = 'wo-detail-container';
  container.appendChild(overlay);
  container.appendChild(panel);

  // Animate open
  requestAnimationFrame(() => {
    overlay.classList.add('open');
    panel.classList.add('open');
  });

  // ESC key handler
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closePanel(overlay, panel);
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);

  return container;
}

function closePanel(overlay: HTMLElement, panel: HTMLElement) {
  // Clear auto-refresh interval
  clearAutoRefresh();

  overlay.classList.remove('open');
  panel.classList.remove('open');
  setTimeout(() => {
    const container = document.getElementById('wo-detail-container');
    if (container) container.remove();
  }, 300);
}

function renderSectionShell(title: string, placeholder: string): HTMLElement {
  const section = document.createElement('div');
  section.className = 'wo-detail-section';
  section.innerHTML = `
    <div class="wo-detail-section-header"><h3>${title}</h3></div>
    <div class="wo-detail-section-body"><div class="wo-detail-empty">${placeholder}</div></div>
  `;
  return section;
}

/* ──────────── Clarification Banner ──────────── */

function renderClarificationBanner(woId: string): HTMLElement {
  const banner = document.createElement('div');
  banner.className = 'clarification-banner';
  banner.innerHTML = `
    <div class="clarification-header">
      <span class="clarification-icon">⏸️</span>
      <span class="clarification-title">Agent Waiting for Clarification</span>
    </div>
    <div class="clarification-body">
      <div class="clarification-loading">Loading clarification request...</div>
    </div>
  `;
  loadClarificationRequest(woId, banner);
  return banner;
}

async function loadClarificationRequest(woId: string, banner: HTMLElement) {
  try {
    const clarifications = await apiFetch<any[]>(
      `/rest/v1/clarification_requests?work_order_id=eq.${woId}&status=eq.pending&order=created_at.desc&limit=1`
    );

    const body = banner.querySelector('.clarification-body')!;

    if (!clarifications || clarifications.length === 0) {
      body.innerHTML = '<div class="clarification-empty">No pending clarification found</div>';
      return;
    }

    const clarification = clarifications[0];
    const options = clarification.options ? JSON.parse(clarification.options) : null;
    const urgency = clarification.urgency || 'normal';

    body.innerHTML = `
      <div class="clarification-question">
        <strong>Question:</strong> ${escapeHtml(clarification.question)}
      </div>
      ${clarification.context ? `
        <div class="clarification-context">
          <strong>Context:</strong> ${escapeHtml(clarification.context)}
        </div>
      ` : ''}
      <div class="clarification-urgency urgency-${urgency}">
        Urgency: <span>${urgency.toUpperCase()}</span>
      </div>
      ${options && options.length > 0 ? `
        <div class="clarification-options">
          <strong>Suggested Options:</strong>
          <div class="clarification-options-list">
            ${options.map((opt: string, idx: number) => `
              <button class="clarification-option-btn" data-option="${escapeHtml(opt)}">${escapeHtml(opt)}</button>
            `).join('')}
          </div>
        </div>
      ` : ''}
      <div class="clarification-form">
        <label for="clarification-response">Your Response:</label>
        <textarea 
          id="clarification-response" 
          class="clarification-textarea"
          placeholder="Provide your answer or clarification..."
          rows="4"
        ></textarea>
        <div class="clarification-actions">
          <button id="submit-clarification" class="btn btn-primary">Submit Answer</button>
        </div>
      </div>
    `;

    // Attach handlers
    const textarea = body.querySelector('#clarification-response') as HTMLTextAreaElement;
    const submitBtn = body.querySelector('#submit-clarification') as HTMLButtonElement;

    // Option buttons populate textarea
    body.querySelectorAll('.clarification-option-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const option = (btn as HTMLElement).dataset.option!;
        textarea.value = option;
      });
    });

    // Submit handler
    submitBtn.addEventListener('click', async () => {
      const response = textarea.value.trim();
      if (!response) {
        alert('Please provide a response');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting...';

      try {
        await apiFetch('/functions/v1/answer-clarification', {
          method: 'POST',
          body: JSON.stringify({
            clarification_id: clarification.id,
            response,
            responded_by: 'portal-user', // TODO: Get actual user ID
          }),
        });

        body.innerHTML = `
          <div class="clarification-success">
            ✅ Response submitted successfully! The work order will resume execution.
          </div>
        `;

        // Refresh the page after 2 seconds to show updated WO status
        setTimeout(() => {
          window.location.reload();
        }, 2000);
      } catch (err: any) {
        alert(`Failed to submit response: ${err.message}`);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Answer';
      }
    });
  } catch (err) {
    const body = banner.querySelector('.clarification-body')!;
    body.innerHTML = '<div class="clarification-empty">Failed to load clarification request</div>';
  }
}

/* ──────────────── Info Section ──────────────── */

function renderInfoSection(wo: WorkOrder): HTMLElement {
  const section = document.createElement('div');
  section.className = 'wo-detail-section';

  const acHtml = wo.acceptance_criteria
    ? renderACList(wo.acceptance_criteria)
    : '<span style="color:var(--text-muted)">None</span>';

  section.innerHTML = `
    <div class="wo-detail-section-header"><h3>Details</h3></div>
    <div class="wo-detail-section-body">
      <div class="wo-info-grid">
        <span class="wo-info-label">Objective</span>
        <span class="wo-info-value objective-text">${escapeHtml(wo.objective || 'N/A')}</span>
        <span class="wo-info-label">AC</span>
        <span class="wo-info-value">${acHtml}</span>
        <span class="wo-info-label">Summary</span>
        <span class="wo-info-value summary-text">${escapeHtml(wo.summary || 'N/A')}</span>
        <span class="wo-info-label">Created</span>
        <span class="wo-info-value">${relativeTime(wo.created_at)}</span>
        ${wo.parent_id ? `<span class="wo-info-label">Parent</span><span class="wo-info-value" style="font-family:var(--font-mono);font-size:12px">${escapeHtml(wo.parent_id)}</span>` : ''}
        ${wo.depends_on && wo.depends_on.length ? `<span class="wo-info-label">Depends On</span><span class="wo-info-value" style="font-family:var(--font-mono);font-size:12px">${wo.depends_on.length} WOs</span>` : ''}
      </div>
    </div>
  `;
  return section;
}

function renderACList(ac: string): string {
  const lines = ac.split('\n').filter(l => l.trim());
  if (lines.length <= 1 && !ac.match(/^\d+[\.\)]/m)) {
    return `<span style="white-space:pre-wrap">${escapeHtml(ac)}</span>`;
  }
  return `<ol class="ac-list">${lines.map(l => {
    const cleaned = l.replace(/^\d+[\.\):\s]+/, '').replace(/^[-*]\s+/, '').trim();
    return cleaned ? `<li>${escapeHtml(cleaned)}</li>` : '';
  }).join('')}</ol>`;
}

/* ──────────────── Execution Log ──────────────── */

async function loadExecutionLog(woId: string, section: HTMLElement) {
  try {
    const entries: ExecutionLogEntry[] = await apiFetch<ExecutionLogEntry[]>(
      `/rest/v1/work_order_execution_log?work_order_id=eq.${woId}&order=created_at.asc&limit=100`
    );

    const body = section.querySelector('.wo-detail-section-body')!;
    const headerEl = section.querySelector('.wo-detail-section-header')!;

    if (!entries || entries.length === 0) {
      body.innerHTML = '<div class="exec-log-empty">No execution log entries</div>';
      return;
    }

    // Update header with count
    headerEl.innerHTML = `<h3>Execution Log</h3><span style="font-size:11px;color:var(--text-muted)">${entries.length} entries</span>`;

    body.innerHTML = `<div class="exec-log-timeline">${entries.map(entry => {
      const detail = extractDetail(entry.detail);
      const time = entry.created_at ? new Date(entry.created_at).toLocaleTimeString() : '';
      return `
        <div class="exec-log-entry">
          <span class="exec-log-phase ${entry.phase || ''}">${escapeHtml(entry.phase || 'unknown')}</span>
          <span class="exec-log-agent">${escapeHtml(entry.agent_name || '--')}</span>
          <div>
            <div class="exec-log-detail">${escapeHtml(detail)}</div>
            <div class="exec-log-time">${time}</div>
          </div>
        </div>
      `;
    }).join('')}</div>`;
  } catch (err) {
    const body = section.querySelector('.wo-detail-section-body')!;
    body.innerHTML = '<div class="exec-log-empty">Failed to load execution log</div>';
  }
}

function extractDetail(detail: any): string {
  if (!detail) return '';
  if (typeof detail === 'string') return detail;
  if (detail.content) return String(detail.content);
  if (detail.tool_name) return `[${detail.tool_name}] ${detail.message || detail.result || ''}`;
  if (detail.message) return String(detail.message);
  if (detail.summary) return String(detail.summary);
  return JSON.stringify(detail).slice(0, 200);
}

/* ──────────────── QA Checklist ──────────────── */

function renderQAChecklist(checklist: any[]): HTMLElement {
  const section = document.createElement('div');
  section.className = 'wo-detail-section';

  if (!checklist || checklist.length === 0) {
    section.innerHTML = `
      <div class="wo-detail-section-header"><h3>QA Checklist</h3></div>
      <div class="wo-detail-section-body">
        <div class="wo-detail-empty">No QA checklist</div>
      </div>
    `;
    return section;
  }

  const passed = checklist.filter(i => i.status === 'pass').length;
  const failed = checklist.filter(i => i.status === 'fail').length;
  const total = checklist.length;
  const verdict = failed > 0 ? 'fail' : (passed === total ? 'pass' : 'pending');
  const verdictLabel = verdict === 'pass' ? 'PASS' : verdict === 'fail' ? 'FAIL' : 'PENDING';

  const icons: Record<string, string> = { pass: '✓', fail: '✗', pending: '○' };

  section.innerHTML = `
    <div class="wo-detail-section-header">
      <h3>QA Checklist</h3>
      <div class="qa-checklist-aggregate">
        <span class="qa-checklist-count">${passed}/${total} passed</span>
        <span class="qa-verdict ${verdict}">${verdictLabel}</span>
      </div>
    </div>
    <div class="wo-detail-section-body">
      <div class="qa-checklist-list">
        ${checklist.map(item => `
          <div class="qa-checklist-item">
            <span class="qa-checklist-icon ${item.status || 'pending'}">${icons[item.status] || icons.pending}</span>
            <span class="qa-checklist-criterion">${escapeHtml(item.criterion || item.id || 'Unknown criterion')}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
  return section;
}

/* ──────────────── QA Findings ──────────────── */

async function loadQAFindings(woId: string, section: HTMLElement) {
  try {
    const findings: QAFinding[] = await apiFetch<QAFinding[]>(
      `/rest/v1/qa_findings?work_order_id=eq.${woId}&order=created_at.desc&limit=50`
    );

    const body = section.querySelector('.wo-detail-section-body')!;
    const headerEl = section.querySelector('.wo-detail-section-header')!;

    if (!findings || findings.length === 0) {
      body.innerHTML = '<div class="wo-detail-empty">No QA findings</div>';
      return;
    }

    headerEl.innerHTML = `<h3>QA Findings</h3><span style="font-size:11px;color:var(--text-muted)">${findings.length} findings</span>`;

    body.innerHTML = `<div class="qa-findings-list">${findings.map((f, idx) => {
      const evidenceStr = f.evidence ? JSON.stringify(f.evidence, null, 2) : '';
      return `
        <div class="qa-finding-item">
          <div class="qa-finding-header">
            <span class="qa-finding-type ${f.finding_type || ''}">${escapeHtml(f.finding_type || 'info')}</span>
            <span class="qa-finding-category">${escapeHtml(f.category || '')}</span>
          </div>
          <div class="qa-finding-description">${escapeHtml(f.description || '')}</div>
          ${evidenceStr ? `
            <button class="qa-finding-evidence-toggle" data-target="evidence-${idx}">Show Evidence</button>
            <div class="qa-finding-evidence" id="evidence-${idx}">${escapeHtml(evidenceStr)}</div>
          ` : ''}
        </div>
      `;
    }).join('')}</div>`;

    // Attach evidence toggle handlers
    body.querySelectorAll('.qa-finding-evidence-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = (btn as HTMLElement).dataset.target!;
        const evidenceEl = document.getElementById(targetId);
        if (evidenceEl) {
          const expanded = evidenceEl.classList.toggle('expanded');
          btn.textContent = expanded ? 'Hide Evidence' : 'Show Evidence';
        }
      });
    });
  } catch (err) {
    const body = section.querySelector('.wo-detail-section-body')!;
    body.innerHTML = '<div class="wo-detail-empty">Failed to load QA findings</div>';
  }
}

/**
 * Open the WO detail panel — main entry point called from workspace.
 */
export async function openWODetail(woId: string, workOrders: WorkOrder[]) {
  // Remove existing panel if any
  const existing = document.getElementById('wo-detail-container');
  if (existing) existing.remove();

  // Find the WO from the already-loaded data
  let wo = workOrders.find(w => w.id === woId);
  if (!wo) {
    // Fallback: fetch directly
    try {
      const data = await apiFetch<WorkOrder[]>(
        `/rest/v1/work_orders?id=eq.${woId}&select=*&limit=1`
      );
      if (data && data.length > 0) wo = data[0];
    } catch (e) {
      console.error('Failed to fetch WO:', e);
    }
  }

  if (!wo) {
    console.error('Work order not found:', woId);
    return;
  }

  const panel = renderWODetailPanel(wo);
  document.body.appendChild(panel);
}
