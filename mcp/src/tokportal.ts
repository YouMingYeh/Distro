// The one rule this server adds on top of TokPortal's own tools: nothing that spends credits or
// changes a live account runs for real unless the caller said dry_run false.

/** TokPortal's naming rule for tools that never spend credits or change anything. */
export const tokportalReads = (tool: string) => /^tokportal_(get|list|export)_/.test(tool);

/** The arguments to send. Read tools get no dry_run at all: TokPortal refuses arguments a tool does not know. */
export function tokportalArgs(tool: string, args: Record<string, unknown>, dryRun: boolean): Record<string, unknown> {
  if (tokportalReads(tool)) return args;
  // A dry_run true inside `arguments` is kept either way, so the safer of the two always wins.
  return dryRun ? { ...args, dry_run: true } : args;
}
