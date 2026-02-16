import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config';

export async function apiFetch<T = any>(endpoint: string, method: 'GET' | 'POST' | 'PATCH' = 'GET', body?: any): Promise<T> {
  const opts: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    },
  };

  if (body) {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(`${SUPABASE_URL}${endpoint}`, opts);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body.substring(0, 200)}`);
  }
  return res.json();
}

export function relativeTime(iso?: string): string {
  if (!iso) return '--';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export function formatDate(iso?: string): string {
  if (!iso) return '--';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
