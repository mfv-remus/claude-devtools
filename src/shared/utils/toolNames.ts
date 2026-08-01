/**
 * Claude Code renamed the subagent-spawn tool from "Task" to "Agent".
 * Sessions recorded before and after the rename both exist on disk, so
 * treat either name as the same tool everywhere we need to identify it.
 */
export function isSubagentSpawnToolName(name: string | undefined): boolean {
  return name === 'Task' || name === 'Agent';
}
