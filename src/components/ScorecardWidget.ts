import { apiFetch, escapeHtml } from '../utils/api';

interface Scorecard {
  id: string;
  work_order_id: string;
  policy_adherence_score: number;
  cost_efficiency_score: number;
  time_efficiency_score: number;
  qa_pass_rate_score: number;
  evidence_completeness_score: number;
  overall_score: number;
  metrics: {
    work_order_slug: string;
    work_order_name: string;
    duration_minutes: number;
    iterations: number;
  };
  scored_at: string;
}

interface ScorecardSummary {
  count: number;
  avg_overall_score: number;
  avg_policy_adherence: number;
  avg_cost_efficiency: number;
  avg_time_efficiency: number;
  avg_qa_pass_rate: number;
  avg_evidence_completeness: number;
}

interface ScorecardResponse {
  scorecards: Scorecard[];
  summary: ScorecardSummary | null;
}

export function createScorecardWidget(): HTMLElement {
  const widget = document.createElement('div');
  widget.className = 'scorecard-widget';
  widget.innerHTML = `
    <h3>Performance Scorecards</h3>
    <div id="scorecard-content" class="scorecard-content">
      <div class="loading-text">Loading scorecards...</div>
    </div>
  `;

  loadScorecards(widget);
  return widget;
}

async function loadScorecards(widget: HTMLElement) {
  try {
    const response = await apiFetch<ScorecardResponse>(
      '/functions/v1/get-scorecard?limit=10',
      'GET'
    );

    const content = widget.querySelector('#scorecard-content');
    if (!content) return;

    if (!response.scorecards || response.scorecards.length === 0) {
      content.innerHTML = '<div class="empty-text">No scorecards yet</div>';
      return;
    }

    // Render summary
    let html = '';
    if (response.summary) {
      html += renderSummary(response.summary);
    }

    // Render recent scorecards
    html += '<div class="scorecard-list">';
    html += '<h4>Recent Completions</h4>';
    html += response.scorecards.slice(0, 5).map(s => renderScorecardItem(s)).join('');
    html += '</div>';

    content.innerHTML = html;
  } catch (error) {
    console.error('Failed to load scorecards:', error);
    const content = widget.querySelector('#scorecard-content');
    if (content) {
      content.innerHTML = '<div class="error-text">Failed to load scorecards</div>';
    }
  }
}

function renderSummary(summary: ScorecardSummary): string {
  return `
    <div class="scorecard-summary">
      <div class="summary-header">
        <span class="summary-title">Average Performance</span>
        <span class="summary-count">${summary.count} WOs</span>
      </div>
      <div class="summary-overall">
        <div class="score-circle ${getScoreClass(summary.avg_overall_score)}">
          <span class="score-value">${summary.avg_overall_score}</span>
        </div>
        <span class="score-label">Overall Score</span>
      </div>
      <div class="summary-dimensions">
        ${renderDimensionBar('Policy', summary.avg_policy_adherence)}
        ${renderDimensionBar('Cost', summary.avg_cost_efficiency)}
        ${renderDimensionBar('Time', summary.avg_time_efficiency)}
        ${renderDimensionBar('QA', summary.avg_qa_pass_rate)}
        ${renderDimensionBar('Evidence', summary.avg_evidence_completeness)}
      </div>
    </div>
  `;
}

function renderDimensionBar(label: string, score: number): string {
  return `
    <div class="dimension-bar">
      <div class="dimension-label">${label}</div>
      <div class="dimension-progress">
        <div class="dimension-fill ${getScoreClass(score)}" style="width: ${score}%"></div>
      </div>
      <div class="dimension-score">${score}</div>
    </div>
  `;
}

function renderScorecardItem(scorecard: Scorecard): string {
  const slug = escapeHtml(scorecard.metrics.work_order_slug || '');
  const overallClass = getScoreClass(scorecard.overall_score);

  return `
    <div class="scorecard-item">
      <div class="scorecard-item-header">
        <span class="scorecard-slug">${slug}</span>
        <span class="scorecard-score ${overallClass}">${scorecard.overall_score}</span>
      </div>
      <div class="scorecard-item-meta">
        <span>${scorecard.metrics.duration_minutes?.toFixed(1) || '?'}m</span>
        <span>·</span>
        <span>${scorecard.metrics.iterations || '?'} iter</span>
      </div>
      <div class="scorecard-mini-bars">
        <div class="mini-bar ${getScoreClass(scorecard.policy_adherence_score)}" 
             style="width: ${scorecard.policy_adherence_score}%" 
             title="Policy: ${scorecard.policy_adherence_score}"></div>
        <div class="mini-bar ${getScoreClass(scorecard.cost_efficiency_score)}" 
             style="width: ${scorecard.cost_efficiency_score}%" 
             title="Cost: ${scorecard.cost_efficiency_score}"></div>
        <div class="mini-bar ${getScoreClass(scorecard.time_efficiency_score)}" 
             style="width: ${scorecard.time_efficiency_score}%" 
             title="Time: ${scorecard.time_efficiency_score}"></div>
        <div class="mini-bar ${getScoreClass(scorecard.qa_pass_rate_score)}" 
             style="width: ${scorecard.qa_pass_rate_score}%" 
             title="QA: ${scorecard.qa_pass_rate_score}"></div>
        <div class="mini-bar ${getScoreClass(scorecard.evidence_completeness_score)}" 
             style="width: ${scorecard.evidence_completeness_score}%" 
             title="Evidence: ${scorecard.evidence_completeness_score}"></div>
      </div>
    </div>
  `;
}

function getScoreClass(score: number): string {
  if (score >= 80) return 'score-excellent';
  if (score >= 60) return 'score-good';
  if (score >= 40) return 'score-fair';
  return 'score-poor';
}
