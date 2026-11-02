/** The message of whatever was thrown; it is not always an Error. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
