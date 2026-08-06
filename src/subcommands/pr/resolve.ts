import { query_gh_project_by_url } from '../../utils/fetch';
import { parse_gh_url, type RequiredPR, type RequiredPRMatch } from '../../utils/sources';
import { delay } from '../../utils/utils';
import { log_debug, log_step, log_warn, tag_count, tag_dim, tag_neutral, tag_primary } from '../../utils/log';

// Workflow conclusions that are treated as failures by the resolver.
// `null` conclusion = still in progress (handled separately).
export const FAILED_WORKFLOW_CONCLUSIONS: ReadonlyArray<string> = ['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required'];

export interface WorkflowRunSummary {
    html_url: string;
    id: number;
    name: string;
    status?: string | null;
    conclusion?: string | null;
}

// Mirrors the shape returned by GH's /actions/runs/{id}/artifacts endpoint, with
// digest already stripped of the leading "sha256:" prefix.
export interface Artifact {
    name: string;
    archive_download_url: string;
    size_in_bytes: number;
    digest: string;
    expired: boolean;
}

//#region Result types

export type ResolveFailureReason =
    | 'no_workflow_runs'
    | 'workflow_failed'
    | 'workflow_timeout'
    | 'no_artifact'
    | 'artifact_filter_miss'
    | 'parse_failed'
    | 'not_supported_url';

export type ResolveResult =
    | { ok: true; reason: 'workflow_artifact'; artifact: Artifact; run_url: string; resolved_sha: string; other_runs: WorkflowRunSummary[] }
    | { ok: false; reason: ResolveFailureReason; detail: string; link?: string };

export interface ResolveOpts {
    build_jobs?: string[];
    artifact_name?: string[];
    allow_failed_workflows?: boolean;
    wait_timeout_ms?: number;
    poll_interval_ms?: number;
    commit_lookback?: number;
}

//#region Dispatcher

// Classify the URL and dispatch to the right SHA-list builder, then pick a run and fetch artifacts.
// Returns a typed reason on every outcome so callers (and log_failure_block) can render exactly what happened.
export async function resolve_artifact_for_url(source_url: string, opts?: ResolveOpts): Promise<ResolveResult> {
    const url_match = parse_gh_url(source_url);
    if (!url_match) return { ok: false, reason: 'parse_failed', detail: `Failed to parse '${source_url}' as a GitHub URL.` };

    const merged_opts: Required<Omit<ResolveOpts, 'build_jobs' | 'artifact_name'>> & Pick<ResolveOpts, 'build_jobs' | 'artifact_name'> = {
        build_jobs: opts?.build_jobs,
        artifact_name: opts?.artifact_name,
        allow_failed_workflows: opts?.allow_failed_workflows ?? false,
        wait_timeout_ms: opts?.wait_timeout_ms ?? 0,
        poll_interval_ms: opts?.poll_interval_ms ?? 30_000,
        commit_lookback: opts?.commit_lookback ?? 10,
    };

    const { owner, project, primary, secondary, key } = url_match;
    log_step(`Resolving artifact for ${tag_primary(`${owner}/${project}`)} ${tag_dim(`(${source_url})`)}`);

    // Direct workflow run URL - skip commit walk entirely.
    if (primary === 'actions' && secondary === 'runs' && key != undefined) {
        return resolve_from_run_id(source_url, key, merged_opts);
    }

    // PR or branch - build a SHA list, then pick a run.
    let shas: string[];
    if (primary === 'pull' && secondary != undefined) {
        shas = await fetch_pr_commit_shas(source_url, secondary);
        log_step(`Found ${tag_count(shas.length)} commit(s) on PR ${tag_neutral(`#${secondary}`)}.`);
    } else if (primary === 'tree' && secondary != undefined) {
        shas = await fetch_branch_commit_shas(source_url, secondary, merged_opts.commit_lookback);
        log_step(`Walking last ${tag_count(shas.length)} commit(s) of branch ${tag_neutral(secondary)}.`);
    } else {
        return { ok: false, reason: 'not_supported_url', detail: `URL primary '${primary ?? '<none>'}' is not handled by resolve_artifact_for_url.` };
    }

    log_debug("Collecting workflows from commits...")
    const pick = await pick_run_from_shas(source_url, shas, merged_opts);
    if (pick == undefined) {
        return { ok: false, reason: 'no_workflow_runs', detail: `No workflow runs found across ${shas.length} commit(s).` };
    }
    if (!pick.ok) return pick;
    
    return select_artifact_from_workflow(source_url, pick.run, pick.other_runs, pick.sha, merged_opts);
}

//#region SHA list builders

async function fetch_pr_commit_shas(source_url: string, pr_number: string): Promise<string[]> {
    const shas: string[] = [];
    const { status: pr_status, body: pr_body } = await query_gh_project_by_url(source_url, `/pulls/${pr_number}`);
    const head_sha = pr_status === '200' && pr_body != null ? ((pr_body as any).head?.sha as string | undefined) : undefined;
    if (head_sha != undefined) shas.push(head_sha);

    const { status, body } = await query_gh_project_by_url(source_url, `/pulls/${pr_number}/commits?per_page=100`);
    if (status === '200' && body != null && Array.isArray(body)) {
        // GH returns oldest-first; reverse to walk newest-first, skipping head (already first).
        for (const commit of (body as any[]).reverse()) {
            const sha = commit.sha as string;
            if (sha !== head_sha) shas.push(sha);
        }
    }
    return shas;
}

async function fetch_branch_commit_shas(source_url: string, branch: string, lookback: number): Promise<string[]> {
    const shas: string[] = [];
    const { status, body } = await query_gh_project_by_url(source_url, `/commits?sha=${encodeURIComponent(branch)}&per_page=${lookback}`);
    if (status === '200' && body != null && Array.isArray(body)) {
        for (const commit of body as any[]) shas.push(commit.sha as string);
    }
    return shas;
}

//#region Pick a workflow run from SHA list

// Walk SHAs newest-first, fetching runs per SHA, picking the first non-failed completed run.
// Honors the wait rule: in-progress runs trigger a wait only when wait_timeout_ms > 0 AND
// (build_jobs set OR no other SHA has any runs).
// When build_jobs is provided, tries each entry in priority order: uses the first matching run
// that passed; if the first match failed but a later entry matched and passed, forgives the failure.
async function pick_run_from_shas(
    source_url: string,
    shas: string[],
    opts: { allow_failed_workflows: boolean; wait_timeout_ms: number; poll_interval_ms: number; build_jobs?: string[] },
): Promise<{ ok: true; run: WorkflowRunSummary; other_runs: WorkflowRunSummary[]; sha: string } | { ok: false; reason: ResolveFailureReason; detail: string; link?: string } | undefined> {
    // First pass - find every SHA that has any runs at all. Used to decide if "first workflow" rule applies.
    const shas_with_runs: Map<string, WorkflowRunSummary[]> = new Map();
    for (const sha of shas) {
        const runs = await fetch_runs_for_sha(source_url, sha);
        if (runs.length > 0) shas_with_runs.set(sha, runs);
    }
    if (shas_with_runs.size === 0) return undefined;

    // Second pass - walk SHAs newest-first. For each SHA with runs, decide what to do.
    for (const sha of shas) {
        const runs = shas_with_runs.get(sha);
        if (runs == undefined) continue;

        let target: WorkflowRunSummary | undefined;

        if (opts.build_jobs != undefined && opts.build_jobs.length > 0) {
            // Try each job name in priority order. Accept the first match that is not failed.
            // If an earlier entry matched but failed and a later entry matched and passed, forgive
            // the failure and use the passing run.
            let first_failed_match: WorkflowRunSummary | undefined;
            for (const job_name of opts.build_jobs) {
                const matches = runs
                    .filter((r) => r.name.toLowerCase() === job_name.toLowerCase())
                    .sort((a, b) => a.id - b.id); // ascending: oldest first, newest last
                if (matches.length === 0) continue;

                const last = matches.at(-1)!;

                // Re-trigger: ≥1 older run with this name failed AND the newest succeeded → use newest.
                if (
                    matches.length > 1 &&
                    matches.slice(0, -1).some((r) => r.conclusion != null && FAILED_WORKFLOW_CONCLUSIONS.includes(r.conclusion)) &&
                    last.conclusion != null &&
                    !FAILED_WORKFLOW_CONCLUSIONS.includes(last.conclusion)
                ) {
                    target = last;
                    break;
                }

                // Fallback: treat newest (last in ascending sort = first in GitHub's response) as single candidate.
                if (last.conclusion != null && FAILED_WORKFLOW_CONCLUSIONS.includes(last.conclusion)) {
                    if (first_failed_match == undefined) first_failed_match = last;
                    continue; // try next entry
                }
                target = last;
                break;
            }
            if (target == undefined) {
                if (first_failed_match == undefined) continue; // no entry matched at all - try next SHA
                if (!opts.allow_failed_workflows) {
                    return { ok: false, reason: 'workflow_failed', detail: `Workflow '${first_failed_match.name}' concluded as ${first_failed_match.conclusion}.`, link: first_failed_match.html_url };
                }
                target = first_failed_match;
            }
        } else {
            // No build_jobs filter: blanket failure check then pick first run.
            const failed = runs.filter((r) => r.conclusion != null && FAILED_WORKFLOW_CONCLUSIONS.includes(r.conclusion));
            if (failed.length > 0 && !opts.allow_failed_workflows) {
                const first_failed = failed[0]!;
                return {
                    ok: false,
                    reason: 'workflow_failed',
                    detail: `Workflow '${first_failed.name}' concluded as ${first_failed.conclusion}.`,
                    link: first_failed.html_url,
                };
            }
            target = runs[0];
            if (target == undefined) continue;
        }

        // If picked run is completed, return it.
        if (target.status === 'completed') {
            const other_runs = runs.filter((r) => r.id !== target!.id);
            log_step(`Found ${tag_count([target, ...other_runs].length)} workflow(s) on commit ${tag_dim(sha.slice(0, 7))}.`);
            return { ok: true, run: target, other_runs, sha };
        }

        // Picked run is in-progress. Check if we should wait.
        const is_first_workflow = shas_with_runs.size === 1;
        const should_wait = opts.wait_timeout_ms > 0 && ((opts.build_jobs != undefined && opts.build_jobs.length > 0) || is_first_workflow);
        if (should_wait) {
            log_step(`Workflow ${tag_primary(target.name)} is in progress, waiting up to ${tag_count(Math.floor(opts.wait_timeout_ms / 1000))}s...`);
            const wait_res = await wait_for_workflow_run(source_url, target.id, { timeout_ms: opts.wait_timeout_ms, poll_interval_ms: opts.poll_interval_ms });
            if (!wait_res.ok) return { ok: false, reason: wait_res.reason, detail: wait_res.detail, link: wait_res.html_url };
            if (FAILED_WORKFLOW_CONCLUSIONS.includes(wait_res.conclusion) && !opts.allow_failed_workflows) {
                return { ok: false, reason: 'workflow_failed', detail: `Workflow '${target.name}' concluded as ${wait_res.conclusion}.`, link: wait_res.html_url };
            }
            const other_runs = runs.filter((r) => r.id !== target!.id);
            return { ok: true, run: { ...target, status: 'completed', conclusion: wait_res.conclusion }, other_runs, sha };
        }
        // Fall through to next-older SHA.
        log_debug(`Workflow ${target.name} in progress on ${sha.slice(0, 7)} - falling through (no wait).`);
    }

    return undefined;
}

async function fetch_runs_for_sha(source_url: string, sha: string): Promise<WorkflowRunSummary[]> {
    const { status, body } = await query_gh_project_by_url(source_url, `/actions/runs?head_sha=${sha}`);
    if (status === '200' && body != null && Array.isArray((body as any).workflow_runs)) {
        return (body as any).workflow_runs as WorkflowRunSummary[];
    }
    return [];
}

//#region Wait

// Poll a workflow run until it completes or the timeout elapses. Caller decides what to do with the conclusion.
export async function wait_for_workflow_run(
    source_url: string,
    run_id: number | string,
    opts: { timeout_ms: number; poll_interval_ms: number },
): Promise<{ ok: true; conclusion: string; html_url: string } | { ok: false; reason: 'workflow_timeout' | 'workflow_failed'; detail: string; html_url: string }> {
    const deadline = Date.now() + opts.timeout_ms;
    let html_url = '';
    while (Date.now() < deadline) {
        const { status, body } = await query_gh_project_by_url(source_url, `/actions/runs/${run_id}`);
        if (status === '200' && body != null) {
            html_url = (body as any).html_url ?? html_url;
            const run_status = (body as any).status as string | null | undefined;
            const conclusion = (body as any).conclusion as string | null | undefined;
            if (run_status === 'completed' && conclusion != null) {
                return { ok: true, conclusion, html_url };
            }
        } else if (status !== '200') {
            // Non-200 on poll - warn but keep polling (transient API issue).
            log_warn(`Polling workflow run ${run_id} returned status ${status}; retrying.`);
        }
        await delay(opts.poll_interval_ms);
    }
    return { ok: false, reason: 'workflow_timeout', detail: `Workflow run ${run_id} did not complete within ${Math.floor(opts.timeout_ms / 1000)}s.`, html_url };
}

//#region Artifact selection from a workflow run

async function resolve_from_run_id(
    source_url: string,
    run_id: string,
    opts: { build_jobs?: string[]; artifact_name?: string[]; allow_failed_workflows: boolean; wait_timeout_ms: number; poll_interval_ms: number },
): Promise<ResolveResult> {
    // Fetch run metadata to know its name and current conclusion.
    const { status, body } = await query_gh_project_by_url(source_url, `/actions/runs/${run_id}`);
    if (status !== '200' || body == null) {
        return { ok: false, reason: 'no_workflow_runs', detail: `Workflow run ${run_id} not found.` };
    }
    const run: WorkflowRunSummary = {
        id: Number(run_id),
        name: ((body as any).name as string) ?? '',
        html_url: ((body as any).html_url as string) ?? '',
        status: (body as any).status,
        conclusion: (body as any).conclusion,
    };
    const resolved_sha = ((body as any).head_sha as string) ?? '';
    return select_artifact_from_workflow(source_url, run, [], resolved_sha, opts);
}

async function select_artifact_from_workflow(
    source_url: string,
    run: WorkflowRunSummary,
    other_runs: WorkflowRunSummary[],
    resolved_sha: string,
    opts: { build_jobs?: string[]; artifact_name?: string[]; allow_failed_workflows: boolean },
): Promise<ResolveResult> {
    // If picked run failed and we don't tolerate that, return.
    if (run.conclusion != null && FAILED_WORKFLOW_CONCLUSIONS.includes(run.conclusion) && !opts.allow_failed_workflows) {
        return { ok: false, reason: 'workflow_failed', detail: `Workflow '${run.name}' concluded as ${run.conclusion}.`, link: run.html_url };
    }

    // Build candidate workflow list - the chosen run first, plus any siblings (for the case where
    // multiple workflows ran on the same commit and the artifact lives on a sibling, not this run).
    const workflows = [run, ...other_runs];
    let collected: { artifact: Artifact, src_run: WorkflowRunSummary }[] = [];
    for (const wf of workflows) {
        const artifacts = await fetch_artifacts_for_run(source_url, wf.id);
        const usable = artifacts.filter((a) => !a.expired).map((arti) => { return { artifact: arti, src_run: wf }});

        // If any build_jobs entry matches this workflow, use it exclusively (skip the other workflows).
        if (opts.build_jobs != undefined && opts.build_jobs.some((j) => j.toLowerCase() === wf.name.toLowerCase())) {
            collected = usable;
            break;
        }
        collected.push(...usable);
    }

    if (collected.length === 0) {
        return { ok: false, reason: 'no_artifact', detail: `No usable (non-expired) artifacts across ${workflows.length} workflow run(s).`, link: run.html_url };
    }
    log_debug(`Found ${collected.length} artifacts: ` + collected.map((arti) => arti.artifact.name))

    // Use filters in the order they were provided via arguments
    if (opts.artifact_name != undefined && opts.artifact_name.length > 0) {
        let matched: typeof collected[number] | undefined;
        let matched_filter: string | undefined;
        outer: for (const filter of opts.artifact_name) {
            for (const item of collected) {
                if (item.artifact.name.toLowerCase().includes(filter.toLowerCase())) {
                    matched = item;
                    matched_filter = filter;
                    break outer;
                }
            }
        }
        if (matched == undefined) {
            return { ok: false, reason: 'artifact_filter_miss', detail: `No artifact matched any filter [${opts.artifact_name.join(', ')}] among ${collected.length} candidates.`, link: run.html_url };
        }
        log_debug(`Selected specific artifact (${tag_neutral(matched.artifact.name)}) via filter '${matched_filter}' from run ${tag_neutral(matched.src_run.name)} (${tag_dim(matched.src_run.id)})...`);

        return { ok: true, reason: 'workflow_artifact', artifact: matched.artifact, run_url: run.html_url, resolved_sha, other_runs };
    }

    if (collected.length > 1) {
        log_warn(`Found ${collected.length} artifacts; using first ('${collected[0]?.artifact.name}'). Use --artifact_name to filter.`);
    } else {
        log_step(`Selected artifact (${tag_neutral(collected[0]!.artifact.name)}) from run ${tag_neutral(collected[0]!.src_run.name)} (${tag_dim(collected[0]!.src_run.id)})...`);
    }

    return { ok: true, reason: 'workflow_artifact', artifact: collected[0]!.artifact, run_url: run.html_url, resolved_sha, other_runs };
}

// Returns artifacts with their digest stripped of the leading "sha256:" prefix.
export async function fetch_artifacts_for_run(source_url: string, run_id: number | string): Promise<Artifact[]> {
    const { status, body } = await query_gh_project_by_url(source_url, `/actions/runs/${run_id}/artifacts`);
    if (status !== '200' || body == null || !Array.isArray((body as any).artifacts)) return [];
    return ((body as any).artifacts as Artifact[]).map((a) => ({
        name: a.name,
        archive_download_url: a.archive_download_url,
        size_in_bytes: a.size_in_bytes,
        digest: typeof a.digest === 'string' && a.digest.startsWith('sha256:') ? a.digest.slice(7) : a.digest,
        expired: a.expired,
    }));
}

//#region Verify PR refs

const SHORTHAND_RE = /^(?:([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+))?#(\d+)$/;

interface VerifiedRequiredPRMatch {
    raw_match: string,
    urls: string[]
}

// Verify uncertain shorthands (#N or owner/repo#N) against the GitHub pulls API.
// Bare #N refs are resolved using context_owner/context_project (the PR whose body is being parsed).
// Refs that resolve to issues or non-existent numbers are discarded; each discard is logged to debug.
// Returns a new match list with uncertain refs either confirmed (uncertain=false, url set) or removed.
export async function verify_uncertain_refs(
    matches: RequiredPRMatch[],
    context_owner: string,
    context_project: string,
): Promise<VerifiedRequiredPRMatch[]> {
    const results: VerifiedRequiredPRMatch[] = [];

    for (const match of matches) {
        const verified: string[] = [];

        for (const ref of match.refs) {
            if (!ref.uncertain) {
                verified.push(ref.url as string);
                continue;
            }

            const shorthand = ref.shorthand!;
            const m = shorthand.match(SHORTHAND_RE);
            if (m == null) {
                log_debug(`verify_uncertain_refs: unparseable shorthand '${shorthand}'; discarding`);
                continue;
            }

            const owner = m[1] ?? context_owner;
            const project = m[2] ?? context_project;
            const number = m[3]!;
            const repo_url = `https://github.com/${owner}/${project}`;

            const { status } = await query_gh_project_by_url(repo_url, `/pulls/${number}`, undefined, [404]);
            if (status !== '200') {
                log_debug(`verify_uncertain_refs: '${shorthand}' -> ${owner}/${project}#${number} is not a PR (status=${status}); discarding`);
                continue;
            }

            verified.push(
                `https://github.com/${owner}/${project}/pull/${number}`,
            );
        }

        if (verified.length > 0) {
            results.push({ urls: verified, raw_match: match.raw_match });
        }
    }

    return results;
}
