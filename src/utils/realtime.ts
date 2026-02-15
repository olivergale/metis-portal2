import { supabase } from "./supabase";
import type { RealtimeChannel } from "@supabase/supabase-js";

/**
 * Subscribe to changes on a specific table.
 * @param table - The table name to subscribe to
 * @param callback - Function to call when a change occurs
 * @param filter - Optional filter string (e.g., "id=eq.123")
 * @returns The RealtimeChannel for cleanup
 */
export function subscribeToTable(
  table: string,
  callback: (payload: any) => void,
  filter?: string
): RealtimeChannel {
  const channelName = `table-changes-${table}`;

  const channel = supabase.channel(channelName);

  channel.on(
    "postgres_changes",
    {
      event: "INSERT",
      schema: "public",
      table,
      filter,
    },
    (payload) => callback(payload)
  );

  channel.on(
    "postgres_changes",
    {
      event: "UPDATE",
      schema: "public",
      table,
      filter,
    },
    (payload) => callback(payload)
  );

  channel.on(
    "postgres_changes",
    {
      event: "DELETE",
      schema: "public",
      table,
      filter,
    },
    (payload) => callback(payload)
  );

  channel.subscribe();

  return channel;
}

/**
 * Subscribe to changes on core Manifold tables.
 * @param onUpdate - Callback receiving (table, payload) for any change
 * @returns Array of RealtimeChannels for cleanup
 */
export function subscribeToManifoldChanges(
  onUpdate: (table: string, payload: any) => void
): RealtimeChannel[] {
  const tables = ["pipeline_runs", "work_orders", "wo_mutations", "wo_events"];

  const channels: RealtimeChannel[] = tables.map((table) => {
    return subscribeToTable(table, (payload) => {
      onUpdate(table, payload);
    });
  });

  return channels;
}

/**
 * Unsubscribe and remove all channels.
 * @param channels - Array of channels to remove
 */
export function unsubscribeAll(channels: RealtimeChannel[]): void {
  channels.forEach((ch) => {
    supabase.removeChannel(ch);
  });
}
