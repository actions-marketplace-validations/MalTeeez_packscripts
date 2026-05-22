import { CLIColor } from './utils';

// Module-level debug flag, flipped by main.ts when --debug is passed.
let DEBUG_ENABLED = false;

const NO_COLOR = process.env['NO_COLOR'] !== undefined;

export function set_debug_enabled(v: boolean): void {
    DEBUG_ENABLED = v;
}

export function is_debug_enabled(): boolean {
    return DEBUG_ENABLED;
}

// Render a continuation line carrying a URL the human reader would click on.
// Single URL per line, dimmed, prefixed with a triangle marker.
function render_link_line(link: string): string {
    return `\n     ${CLIColor.FgGray}▸ ${CLIColor.FgGray18}${link}${CLIColor.Reset}`;
}

// Append the link continuation to a message if one was provided.
function with_link(msg: string, link?: string): string {
    return link == undefined ? msg : msg + render_link_line(link);
}

//#region Standard prefixed logs

// Plain info line - no prefix, just the message body. Used for high-level narration.
export function log_info(msg: string, link?: string): void {
    console.info(with_link(msg, link));
}

// Gray sub-bullet for progress / step lines under an info line.
export function log_step(msg: string, link?: string): void {
    console.info(with_link(`${CLIColor.FgGray}-${CLIColor.Reset} ${msg}`, link));
}

// Green check, for finished-successfully lines.
export function log_ok(msg: string, link?: string): void {
    console.info(with_link(`${CLIColor.FgGreen11}✔${CLIColor.Reset}  ${msg}`, link));
}

// Yellow WARN prefix - non-fatal issues the user should know about.
export function log_warn(msg: string, link?: string): void {
    console.warn(with_link(`${CLIColor.FgYellow1}WARN:${CLIColor.Reset} ${msg}`, link));
}

// Red ERR prefix - fatal issues, usually followed by a throw or return.
export function log_err(msg: string, link?: string): void {
    console.error(with_link(`${CLIColor.FgRed10}ERR:${CLIColor.Reset} ${msg}`, link));
}

// Debug, only emitted when --debug was passed on the CLI.
export function log_debug(msg: string, link?: string): void {
    if (!DEBUG_ENABLED) return;
    console.info(with_link(`${CLIColor.FgGray}DEBUG:${CLIColor.Reset} ${CLIColor.FgGray18}${msg}${CLIColor.Reset}`, link));
}

//#region Inline value tags
// Replace the long ${CLIColor.Bg...}${CLIColor.Fg...}${CLIColor.Bright} ... ${CLIColor.Reset} chains
// scattered through pr.ts/version.ts. Each helper accepts a string or number for convenience.

// Main subject highlight - PR ids, run ids, artifact names. Blue background.
export function tag_primary(s: string | number): string {
    if (NO_COLOR) return `${CLIColor.FgBlue9}${CLIColor.Bright}[${s}]${CLIColor.Reset}`;
    return `${CLIColor.BgBlue9}${CLIColor.FgBlack} ${s} ${CLIColor.Reset}`;
}

// Secondary subject - filters, branch names, build job names. Teal background.
export function tag_neutral(s: string | number): string {
    if (NO_COLOR) return `${CLIColor.FgTeal6}${CLIColor.Bright}[${s}]${CLIColor.Reset}`;
    return `${CLIColor.BgTeal6}${CLIColor.FgBlack} ${s} ${CLIColor.Reset}`;
}

// Parenthetical detail - hashes, sizes, paths inside (...). Gray foreground only.
export function tag_dim(s: string | number): string {
    return `${CLIColor.FgGray18}${s}${CLIColor.Reset}`;
}

// Attachment detail - files & paths. Provides brackets
export function tag_bracket(s: string | number): string {
    return `${CLIColor.FgGray}(${tag_dim(s)}${CLIColor.FgGray})${CLIColor.Reset}`
}

// Number-worth-emphasising - counts, sizes, "N of M".
export function tag_count(n: string | number): string {
    return `${CLIColor.FgWhite}${CLIColor.Bright}${n}${CLIColor.Reset}`;
}

// Failed-state highlight - failed workflow names, error reasons surfaced inline.
export function tag_fail(s: string | number): string {
    return `${CLIColor.FgRed10}${CLIColor.Bright}${s}${CLIColor.Reset}`;
}

// Success-state highlight - succeeded workflow names, "ok" reasons surfaced inline.
export function tag_ok(s: string | number): string {
    return `${CLIColor.FgGreen11}${s}${CLIColor.Reset}`;
}

//#region Structured failure block

export interface FailureBlock {
    // Top-line summary, e.g. "PR dependency resolution failed".
    title: string;
    // Typed reason string from the failing function.
    cause: string;
    // The PR being processed when failure occurred.
    pr_under_test?: { id: string; url: string };
    // The dep PR that triggered the failure (if applicable).
    dep_pr?: { id: string; url: string };
    // The workflow run involved, when failure points at a specific run.
    workflow_run?: { name: string; url: string };
    // Free-form extra fields, each rendered as `<label>: <value>  <link>`.
    extra?: Array<[label: string, value: string, link?: string]>;
    // Actionable hint for the developer reading the CI log.
    hint?: string;
}

// Render a structured fatal-error block for CI viewers. Labels are padded to a common
// width so the URLs / values line up. Optional fields are omitted entirely.
export function log_failure_block(block: FailureBlock): void {
    const rows: Array<{ label: string; value: string; link?: string }> = [];
    rows.push({ label: 'Cause', value: block.cause });
    if (block.pr_under_test) rows.push({ label: 'PR under test', value: block.pr_under_test.id, link: block.pr_under_test.url });
    if (block.dep_pr) rows.push({ label: 'Dep PR', value: block.dep_pr.id, link: block.dep_pr.url });
    if (block.workflow_run) rows.push({ label: 'Workflow run', value: block.workflow_run.name, link: block.workflow_run.url });
    if (block.extra) {
        for (const [label, value, link] of block.extra) {
            rows.push({ label, value, link });
        }
    }
    if (block.hint) rows.push({ label: 'Hint', value: block.hint });

    // Pad labels to the longest label width + 1 space, for column alignment.
    const max_label_length = rows.reduce((max, row) => Math.max(max, row.label.length), 0);

    const lines: string[] = [];
    lines.push(`${CLIColor.FgRed10}ERR:${CLIColor.Reset} ${CLIColor.Bright}${block.title}${CLIColor.Reset}`);
    for (const row of rows) {
        const padded_label = row.label.padEnd(max_label_length);
        const link_part = row.link != undefined ? `  ${CLIColor.FgGray18}${row.link}${CLIColor.Reset}` : '';
        lines.push(`  ${CLIColor.FgGray}${padded_label}${CLIColor.Reset}  ${row.value}${link_part}`);
    }

    console.error(lines.join('\n'));
}
