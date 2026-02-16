import { useState, useEffect, useRef, useCallback } from 'react';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../utils/config.ts';

interface Thread {
  id: string;
  title: string;
  created_at: string;
  message_count?: number;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  metadata?: { tokens?: number; cost?: number; latency?: number };
}

export default function Chat() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load threads
  useEffect(() => {
    fetchThreads();
  }, []);

  async function fetchThreads() {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/portal-threads`, {
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
      });
      if (res.ok) {
        const data = await res.json();
        setThreads(data.threads || []);
      }
    } catch (e) {
      console.error('Failed to load threads:', e);
    }
  }

  // Load messages when thread changes
  useEffect(() => {
    if (!activeThread) { setMessages([]); return; }
    fetchMessages(activeThread);
  }, [activeThread]);

  async function fetchMessages(threadId: string) {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/portal-threads?thread_id=${threadId}`, {
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
      });
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages || []);
      }
    } catch (e) {
      console.error('Failed to load messages:', e);
    }
  }

  // Scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || streaming) return;
    const userMsg = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    setStreaming(true);

    try {
      const body: any = { message: userMsg };
      if (activeThread) body.thread_id = activeThread;

      const res = await fetch(`${SUPABASE_URL}/functions/v1/portal-chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // Stream response
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let assistantContent = '';

      setMessages(prev => [...prev, { role: 'assistant', content: '' }]);

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });

          // Parse SSE events
          const lines = chunk.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.type === 'content_block_delta' && data.delta?.text) {
                  assistantContent += data.delta.text;
                  setMessages(prev => {
                    const updated = [...prev];
                    updated[updated.length - 1] = { role: 'assistant', content: assistantContent };
                    return updated;
                  });
                }
                if (data.type === 'message_stop' && data.thread_id) {
                  setActiveThread(data.thread_id);
                  fetchThreads();
                }
              } catch {
                // Non-JSON SSE or plain text
                assistantContent += line.slice(6);
                setMessages(prev => {
                  const updated = [...prev];
                  updated[updated.length - 1] = { role: 'assistant', content: assistantContent };
                  return updated;
                });
              }
            }
          }
        }
      }
    } catch (e) {
      console.error('Chat error:', e);
      setMessages(prev => [...prev, { role: 'assistant', content: 'Error: Failed to get response' }]);
    }
    setStreaming(false);
  }, [input, activeThread, streaming]);

  return (
    <div style={styles.layout}>
      {/* Thread sidebar */}
      <div style={styles.threadSidebar}>
        <button className="btn btn-primary" style={{ width: '100%', marginBottom: 12 }} onClick={() => {
          setActiveThread(null);
          setMessages([]);
        }}>
          + New Chat
        </button>
        {threads.map(t => (
          <div
            key={t.id}
            onClick={() => setActiveThread(t.id)}
            style={{
              ...styles.threadItem,
              background: activeThread === t.id ? 'var(--accent-subtle)' : 'transparent',
              color: activeThread === t.id ? 'var(--accent)' : 'var(--text-secondary)',
            }}
          >
            <div style={styles.threadTitle}>{t.title || 'Untitled'}</div>
            <div style={styles.threadMeta}>{new Date(t.created_at).toLocaleDateString()}</div>
          </div>
        ))}
      </div>

      {/* Chat main */}
      <div style={styles.chatMain}>
        <div style={styles.messageArea}>
          {messages.length === 0 && (
            <div style={styles.emptyChat}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>{'\u2699'}</div>
              <div style={{ fontSize: 15, fontWeight: 500 }}>ENDGAME Command Center</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>Start a conversation with the portal assistant</div>
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} style={{
              ...styles.message,
              alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
              background: msg.role === 'user' ? 'var(--accent)' : 'var(--bg-elevated)',
              color: msg.role === 'user' ? 'white' : 'var(--text-primary)',
              maxWidth: '75%',
            }}>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.6 }}>{msg.content}</div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        <div style={styles.inputArea}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
            placeholder="Type a message..."
            style={styles.textarea}
            rows={1}
          />
          <button className="btn btn-primary" onClick={sendMessage} disabled={streaming || !input.trim()}>
            {streaming ? '...' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  layout: {
    display: 'flex',
    height: 'calc(100vh - 48px)',
    margin: '-24px',
  },
  threadSidebar: {
    width: 240,
    borderRight: '1px solid var(--border-default)',
    padding: 12,
    overflowY: 'auto' as const,
    background: 'var(--bg-surface)',
  },
  threadItem: {
    padding: '10px 12px',
    borderRadius: 6,
    cursor: 'pointer',
    marginBottom: 2,
    transition: 'background 0.1s',
  },
  threadTitle: {
    fontSize: 13,
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  threadMeta: {
    fontSize: 11,
    color: 'var(--text-muted)',
    marginTop: 2,
  },
  chatMain: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
  },
  messageArea: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: 24,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
  },
  emptyChat: {
    textAlign: 'center' as const,
    color: 'var(--text-secondary)',
    marginTop: 'auto',
    marginBottom: 'auto',
  },
  message: {
    padding: '10px 14px',
    borderRadius: 12,
    animation: 'fadeIn 0.2s ease-out',
  },
  inputArea: {
    display: 'flex',
    gap: 8,
    padding: '12px 24px',
    borderTop: '1px solid var(--border-default)',
    background: 'var(--bg-surface)',
  },
  textarea: {
    flex: 1,
    resize: 'none' as const,
    padding: '10px 14px',
    borderRadius: 8,
    fontSize: 14,
    lineHeight: 1.5,
    minHeight: 44,
    maxHeight: 120,
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-default)',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-sans)',
  },
};
