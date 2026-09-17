/** IANA timezone of the host running this process (scheduler / API). */
export function getServerTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
