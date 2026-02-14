import type { WorkOrder } from '../types';

/**
 * Render action buttons for work order transitions via wo-transition-api
 */
export function renderActionButtons(wo: WorkOrder): HTMLElement | null {
  const section = document.createElement('div');
  section.className = 'wo-detail-section wo-actions';
  section.innerHTML = `
    <div class="wo-detail-section-header"><h3>Actions</h3></div>
    <div class="wo-detail-section-body">
      <div class="wo-action-buttons" id="wo-action-buttons-${wo.id}" style="display:flex;gap:8px;flex-wrap:wrap;"></div>
    </div>
  `;

  const buttonsContainer = section.querySelector(`#wo-action-buttons-${wo.id}`)!;
  const buttons: HTMLButtonElement[] = [];

  // Determine which buttons to show based on status
  if (wo.status === 'draft' || wo.status === 'ready') {
    buttons.push(createActionButton('Start Work', 'start_work', wo.id, 'primary'));
  }
  
  if (wo.status === 'pending_approval') {
    buttons.push(createActionButton('Approve', 'approve', wo.id, 'success'));
    buttons.push(createActionButton('Reject', 'reject', wo.id, 'danger'));
  }
  
  if (wo.status === 'in_progress') {
    buttons.push(createActionButton('Submit for Review', 'submit_for_review', wo.id, 'primary'));
    buttons.push(createActionButton('Cancel', 'cancel', wo.id, 'danger'));
  }
  
  if (wo.status === 'review') {
    buttons.push(createActionButton('Mark Done', 'mark_done', wo.id, 'success'));
    buttons.push(createActionButton('Reject', 'reject', wo.id, 'danger'));
  }
  
  if (wo.status === 'blocked' || wo.status === 'blocked_on_input') {
    buttons.push(createActionButton('Cancel', 'cancel', wo.id, 'danger'));
  }

  if (buttons.length === 0) {
    return null; // No actions available
  }

  buttons.forEach(btn => buttonsContainer.appendChild(btn));
  return section;
}

function createActionButton(
  label: string,
  event: string,
  woId: string,
  style: 'primary' | 'success' | 'danger'
): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = `btn btn-${style} wo-action-btn`;
  button.textContent = label;
  button.dataset.event = event;
  button.dataset.woId = woId;
  button.style.cssText = 'padding:8px 16px;border-radius:4px;border:none;cursor:pointer;font-size:14px;';
  
  // Button styles
  if (style === 'primary') {
    button.style.backgroundColor = '#2563eb';
    button.style.color = 'white';
  } else if (style === 'success') {
    button.style.backgroundColor = '#16a34a';
    button.style.color = 'white';
  } else if (style === 'danger') {
    button.style.backgroundColor = '#dc2626';
    button.style.color = 'white';
  }
  
  button.addEventListener('click', async () => {
    await handleWorkOrderAction(woId, event, button);
  });
  
  return button;
}

async function handleWorkOrderAction(
  woId: string,
  event: string,
  button: HTMLButtonElement
) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'Processing...';
  button.style.opacity = '0.6';

  try {
    const response = await fetch(
      'https://phfblljwuvzqzlbzkzpr.supabase.co/functions/v1/wo-transition-api',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBoZmJsbGp3dXZ6cXpsYnprenByIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk1MjAzODgsImV4cCI6MjA4NTA5NjM4OH0.mWIj2vtQb1F2Pk540f_S9WwsZFwZK0n6oeqUmZgDZlA',
          'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBoZmJsbGp3dXZ6cXpsYnprenByIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk1MjAzODgsImV4cCI6MjA4NTA5NjM4OH0.mWIj2vtQb1F2Pk540f_S9WwsZFwZK0n6oeqUmZgDZlA',
        },
        body: JSON.stringify({
          work_order_id: woId,
          event: event,
          payload: {},
          actor: 'portal-user'
        }),
      }
    );

    const result = await response.json();

    if (!response.ok) {
      // Handle 422 (transition rejected) or other errors
      if (response.status === 422) {
        const errorMsg = result.error || result.message || 'Transition rejected';
        alert(`Transition Failed: ${errorMsg}`);
      } else {
        alert(`Error: ${result.error || result.message || 'Unknown error'}`);
      }
      button.disabled = false;
      button.textContent = originalText;
      button.style.opacity = '1';
      return;
    }

    // Success - show message and refresh
    alert(`Success! Work order transitioned via "${event}" event.`);
    
    // Reload the page to refresh WO data
    setTimeout(() => {
      window.location.reload();
    }, 500);
    
  } catch (error: any) {
    alert(`Failed to execute action: ${error.message}`);
    button.disabled = false;
    button.textContent = originalText;
    button.style.opacity = '1';
  }
}
