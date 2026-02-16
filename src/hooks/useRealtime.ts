import { useEffect, useRef } from 'react';
import { supabase } from '../utils/supabase.ts';
import type { RealtimeChannel } from '@supabase/supabase-js';

export function useRealtime(
  table: string,
  callback: (payload: any) => void,
  filter?: string
) {
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    const channel: RealtimeChannel = supabase
      .channel(`rt-${table}-${filter || 'all'}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table, filter }, (p) => cbRef.current(p))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table, filter }, (p) => cbRef.current(p))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table, filter }, (p) => cbRef.current(p))
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [table, filter]);
}

export function useRealtimeMulti(
  tables: string[],
  callback: (table: string, payload: any) => void
) {
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    const channels: RealtimeChannel[] = tables.map((t) => {
      return supabase
        .channel(`rt-multi-${t}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: t }, (p) => cbRef.current(t, p))
        .subscribe();
    });

    return () => { channels.forEach((ch) => supabase.removeChannel(ch)); };
  }, [tables.join(',')]);
}
