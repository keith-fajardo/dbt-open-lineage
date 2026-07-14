/** dbt selectors are whitespace-delimited tokens (e.g. `tag:mart --exclude
 * config.materialized:view`). `--full-refresh` isn't real selector syntax —
 * detected and stripped by exact token match, which is simpler and more
 * robust than a regex with lookarounds and can't mangle adjacent tokens. */
const FULL_REFRESH_TOKEN = "--full-refresh";

export function hasFullRefreshFlag(text: string): boolean {
  return text.split(/\s+/).includes(FULL_REFRESH_TOKEN);
}

export function stripFullRefreshFlag(text: string): string {
  return text
    .split(/\s+/)
    .filter((t) => t !== FULL_REFRESH_TOKEN && t !== "")
    .join(" ");
}
