import { apiFetch, escapeHtml } from '../utils/api';
import type { WOEvent } from '../types';

let autoRefreshInterval: number | null = null;

/**
 * Load and render WO Events Timeline
 */
export async function loadWOEvents(woId: string, section: HTMLElement) {
  try {
    const events: WOEvent[] = await apiFetch<WOEvent[]>(
      `/rest/v1/wo_events?work_order_id=eq.${woId}&order=created_at.asc&limit=100`
    );

    const body = section.querySelector('.wo-detail-section-body')!;
    const headerEl = section.querySelector('.wo-detail-section-header')!;

    if (!events || events.length === 0) {
      body.innerHTML = '<div class="wo-events-empty">No events yet (pre-migration WO or no state changes)</div>';
      return;
    }

    headerEl.innerHTML = `<h3>WO Events Timeline</h3><span style="font-size:11px;color:var(--text-muted)">${events.length} events</span>`;

    body.innerHTML = `<div class="wo-events-timeline">${events.map((event, idx) => {
      const time = event.created_at ? new Date(event.created_at).toLocaleTimeString() : '';
      const dateStr = event.created_at ? new Date(event.created_at).toLocaleDateString() : '';
      const statusArrow = event.previous_status && event.new_status 
        ? `<span class="wo-event-status-transition">${escapeHtml(event.previous_status)} → ${escapeHtml(event.new_status)}</span>`
        : event.new_status
        ? `<span class="wo-event-status-transition">→ ${escapeHtml(event.new_status)}</span>`
        : '';
      
      const effects = event.payload?.effects || [];
      const effectsCount = Array.isArray(effects) ? effects.length : 0;
      const effectsBadge = effectsCount > 0 
        ? `<span class="wo-event-effects-badge" title="${effectsCount} effect(s)">${effectsCount} effect${effectsCount !== 1 ? 's' : ''}</span>`
        : '';

      const hasDetail = event.payload && Object.keys(event.payload).length > 0;
      const detailId = `wo-event-detail-${idx}`;
      const payloadStr = hasDetail ? JSON.stringify(event.payload, null, 2) : '';

      return `
        <div class="wo-event-entry">
          <div class="wo-event-timestamp">
            <div class="wo-event-time">${time}</div>
            <div class="wo-event-date">${dateStr}</div>
          </div>
          <div class="wo-event-marker"></div>
          <div class="wo-event-content">
            <div class="wo-event-header">
              <span class="wo-event-type ${event.event_type}">${escapeHtml(event.event_type)}</span>
              ${effectsBadge}
            </div>
            ${statusArrow ? `<div class="wo-event-status">${statusArrow}</div>` : ''}
            <div class="wo-event-actor">by ${escapeHtml(event.actor)}</div>
            ${hasDetail ? `
              <button class="wo-event-detail-toggle" data-target="${detailId}">Show Details</button>
              <div class="wo-event-detail" id="${detailId}">
                <div class="wo-event-detail-section">
                  <strong>Payload:</strong>
                  <pre class="wo-event-json">${escapeHtml(payloadStr)}</pre>
                </div>
              </div>
            ` : ''}
          </div>
        </div>
      `;
    }).join('')}</div>`;

    body.querySelectorAll('.wo-event-detail-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = (btn as HTMLElement).dataset.target!;
        const detailEl = document.getElementById(targetId);
        if (detailEl) {
          const expanded = detailEl.classList.toggle('expanded');
          btn.textContent = expanded ? 'Hide Details' : 'Show Details';
        }
      });
    });
  } catch (err) {
    const body = section.querySelector('.wo-detail-section-body')!;
    body.innerHTML = '<div class="wo-events-empty">Failed to load WO events</div>';
  }
}

/**
 * Setup auto-refresh for in_progress WOs
 */
export function setupAutoRefresh(woId: string, section: HTMLElement) {
  if (autoRefreshInterval !== null) {
    clearInterval(autoRefreshInterval);
  }

  autoRefreshInterval = window.setInterval(() => {
    loadWOEvents(woId, section);
  }, 10000);
}

/**
 * Clear auto-refresh interval
 */
export function clearAutoRefresh() {
  if (autoRefreshInterval !== null) {
    clearInterval(autoRefreshInterval);
    autoRefreshInterval = null;
  }
}
