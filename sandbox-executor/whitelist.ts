/**
 * Command whitelist for sandbox executor
 * Only these commands and their specified subcommands are allowed
 */

export interface WhitelistEntry {
  command: string;
  allowedSubcommands?: string[];
}

export const COMMAND_WHITELIST: WhitelistEntry[] = [
  { command: "deno", allowedSubcommands: ["check", "test", "lint", "fmt"] },
  { command: "grep" },
  { command: "find" },
  { command: "cat" },
  { command: "head" },
  { command: "tail" },
  { command: "wc" },
  { command: "diff" },
  { command: "jq" },
];

export function isCommandAllowed(command: string, args: string[]): boolean {
  const entry = COMMAND_WHITELIST.find((e) => e.command === command);
  if (!entry) return false;

  // If no subcommands specified, allow the command
  if (!entry.allowedSubcommands || entry.allowedSubcommands.length === 0) {
    return true;
  }

  // If subcommands are specified, check the first arg
  if (args.length === 0) return false;
  return entry.allowedSubcommands.includes(args[0]);
}
