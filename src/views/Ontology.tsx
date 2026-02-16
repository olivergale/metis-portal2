import { useState, useMemo } from 'react';
import { useRealtime } from '../hooks/useRealtime.ts';
import { apiFetch, relativeTime } from '../utils/api.ts';
import type { ObjectRegistry } from '../types/index.ts';

interface OntologyObject {
  object_type: string;
  object_name: string;
  properties: Record<string, unknown>;
  valid_actions: string[];
  parent_id: string | null;
  created_at: string;
}

export default function Ontology() {
  const [objects, setObjects] = useState<OntologyObject[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Load ontology data
  useState(() => {
    apiFetch('/rest/v1/object_registry?select=object_type,object_name,properties,valid_actions,parent_id,created_at&order=object_type,object_name&limit=5000', 'GET')
      .then(data => {
        setObjects(data as OntologyObject[]);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  });

  // Realtime subscription
  useRealtime('object_registry', (payload) => {
    const record = payload.new || payload.old;
    if (payload.eventType === 'INSERT') {
      setObjects(prev => [...prev, record as OntologyObject]);
    } else if (payload.eventType === 'DELETE') {
      setObjects(prev => prev.filter(o => o.object_name !== record.object_name));
    }
  });

  // Group by type
  const grouped = useMemo(() => {
    const groups: Record<string, OntologyObject[]> = {};
    objects.forEach(obj => {
      const type = obj.object_type || 'unknown';
      if (!groups[type]) groups[type] = [];
      groups[type].push(obj);
    });
    return groups;
  }, [objects]);

  // Filtered objects
  const filteredObjects = useMemo(() => {
    let result = objects;
    if (filterType !== 'all') {
      result = result.filter(o => o.object_type === filterType);
    }
    if (search) {
      const s = search.toLowerCase();
      result = result.filter(o => 
        o.object_name.toLowerCase().includes(s) ||
        (o.properties && JSON.stringify(o.properties).toLowerCase().includes(s))
      );
    }
    return result;
  }, [objects, filterType, search]);

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    objects.forEach(obj => {
      const type = obj.object_type || 'unknown';
      counts[type] = (counts[type] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [objects]);

  if (loading) {
    return <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>Loading ontology...</div>;
  }

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600 }}>System Ontology</h1>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {objects.length} objects
        </span>
      </div>

      {/* Search and filters */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
        <input
          type="text"
          placeholder="Search objects..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            flex: 1,
            padding: '8px 12px',
            borderRadius: 6,
            border: '1px solid var(--border-default)',
            background: 'var(--bg-surface)',
            color: 'var(--text-primary)',
            fontSize: 13,
          }}
        />
        <select
          value={filterType}
          onChange={e => setFilterType(e.target.value)}
          style={{
            padding: '8px 12px',
            borderRadius: 6,
            border: '1px solid var(--border-default)',
            background: 'var(--bg-surface)',
            color: 'var(--text-primary)',
            fontSize: 13,
          }}
        >
          <option value="all">All Types</option>
          {typeCounts.map(([type, count]) => (
            <option key={type} value={type}>{type} ({count})</option>
          ))}
        </select>
      </div>

      {/* Type summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 24 }}>
        {typeCounts.map(([type, count]) => (
          <div
            key={type}
            onClick={() => setFilterType(filterType === type ? 'all' : type)}
            style={{
              padding: '12px 16px',
              borderRadius: 8,
              border: '1px solid var(--border-default)',
              background: filterType === type ? 'var(--accent-subtle)' : 'var(--bg-surface)',
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
          >
            <div style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 4 }}>
              {type}
            </div>
            <div style={{ fontSize: 24, fontWeight: 600, color: filterType === type ? 'var(--accent)' : 'var(--text-primary)' }}>
              {count}
            </div>
          </div>
        ))}
      </div>

      {/* Object list */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 8, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-default)' }}>
              <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: 'var(--text-secondary)', width: 180 }}>Name</th>
              <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: 'var(--text-secondary)', width: 120 }}>Type</th>
              <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: 'var(--text-secondary)' }}>Properties</th>
              <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: 'var(--text-secondary)', width: 100 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredObjects.slice(0, 100).map(obj => (
              <>
                <tr
                  key={obj.object_name}
                  onClick={() => setExpandedId(expandedId === obj.object_name ? null : obj.object_name)}
                  style={{ borderBottom: '1px solid var(--border-default)', cursor: 'pointer', background: expandedId === obj.object_name ? 'var(--bg-hover)' : 'transparent' }}
                >
                  <td style={{ padding: '10px 14px', fontFamily: 'monospace', fontSize: 12 }}>{obj.object_name}</td>
                  <td style={{ padding: '10px 14px' }}>
                    <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}>
                      {obj.object_type}
                    </span>
                  </td>
                  <td style={{ padding: '10px 14px', color: 'var(--text-muted)', fontSize: 12 }}>
                    {obj.properties && Object.keys(obj.properties).length > 0 
                      ? Object.keys(obj.properties).slice(0, 3).join(', ') + (Object.keys(obj.properties).length > 3 ? '...' : '')
                      : '-'}
                  </td>
                  <td style={{ padding: '10px 14px', color: 'var(--text-muted)' }}>
                    {obj.valid_actions ? obj.valid_actions.slice(0, 2).join(', ') : '-'}
                  </td>
                </tr>
                {expandedId === obj.object_name && (
                  <tr>
                    <td colSpan={4} style={{ padding: 16, background: 'var(--bg-hover)', borderBottom: '1px solid var(--border-default)' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase' }}>Properties</div>
                          <pre style={{ fontSize: 11, background: 'var(--bg-surface)', padding: 12, borderRadius: 6, overflow: 'auto', maxHeight: 200 }}>
                            {JSON.stringify(obj.properties || {}, null, 2)}
                          </pre>
                        </div>
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase' }}>Valid Actions</div>
                          <pre style={{ fontSize: 11, background: 'var(--bg-surface)', padding: 12, borderRadius: 6, overflow: 'auto', maxHeight: 200 }}>
                            {JSON.stringify(obj.valid_actions || [], null, 2)}
                          </pre>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
        {filteredObjects.length > 100 && (
          <div style={{ padding: 12, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, borderTop: '1px solid var(--border-default)' }}>
            Showing 100 of {filteredObjects.length} objects
          </div>
        )}
      </div>
    </div>
  );
}
