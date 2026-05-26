import { ANNOTATED_FILE } from '../utils/config';
import { assert_gh_key } from '../utils/fetch';
import { read_saved_mods, type mod_object } from '../utils/mods';
import { log_debug, log_err, log_failure_block, log_info, log_ok, log_warn, tag_count, tag_neutral, tag_primary } from '../utils/log';
import { apply_nodes_in_order, build_dep_graph, new_gh_cache, type BuildOpts, type DepGraph, type DepNode, type PRStateKind } from './pr/graph';
import { resolve_artifact_for_url, type Artifact } from './pr/resolve';

// Re-export Artifact so existing `import { Artifact } from './pr'` keeps working (used by version.ts).
export type { Artifact } from './pr/resolve';

// Back-compat shim for version.ts which still imports get_dl_url_from_github_url.
// New code should call resolve_artifact_for_url directly and inspect the typed result.
export async function get_dl_url_from_github_url(
    source_url: string,
    build_job?: string,
    artifact_name?: string,
    commit_lookback: number = 10,
    allow_failed_workflows: boolean = false,
): Promise<Artifact | undefined> {
    const res = await resolve_artifact_for_url(source_url, {
        build_jobs: build_job != undefined ? [build_job] : undefined,
        artifact_name: artifact_name != undefined ? [artifact_name] : undefined,
        allow_failed_workflows,
        commit_lookback,
    });
    return res.ok ? res.artifact : undefined;
}

//#region apply_github_pr

export interface ApplyOptions {
    dry: boolean;
    build_jobs?: string[];
    artifact_name?: string[];
    allow_failed_workflows?: boolean;
    allow_external_owners?: boolean;
    other_allowed_owners?: string[];
    wait_timeout_ms?: number;
    poll_interval_ms?: number;
    pack_variant_name?: string;
}

// Orchestrator: build the dep graph, surface any failures with structured blocks, then apply nodes in order.
export async function apply_github_pr(source_url: string | undefined, options: ApplyOptions, _traced_prs?: string[], mod_map?: Map<string, mod_object>): Promise<void> {
    if (source_url == undefined) {
        log_err('Missing source url.');
        throw Error();
    }
    assert_gh_key();
    mod_map = mod_map ?? (await read_saved_mods(ANNOTATED_FILE));
    const cache = new_gh_cache();

    const build_opts: BuildOpts = {
        build_jobs: options.build_jobs,
        artifact_name: options.artifact_name,
        allow_failed_workflows: options.allow_failed_workflows,
        allow_external_owners: options.allow_external_owners,
        other_allowed_owners: options.other_allowed_owners,
        wait_timeout_ms: options.wait_timeout_ms,
        poll_interval_ms: options.poll_interval_ms,
        skip_artifact_download: false,
    };

    log_info(`Building dependency graph from ${tag_primary(source_url)}...`);
    const graph = await build_dep_graph(source_url, build_opts, mod_map, cache);

    if (graph.preflight_absorbed.length > 0 || graph.preflight_failures.length > 0) {
        log_info(`Preflight report for ${tag_primary(source_url)}:`);
        for (const pf of graph.preflight_absorbed) {
            log_ok(`  ${tag_neutral(pf.dep_url)} - ${pf.result.reason}`);
        }
        for (const pf of graph.preflight_failures) {
            log_err(`  ${tag_neutral(pf.dep_url)} - ${pf.result.reason}`);
        }
    } else if (graph.owner_rejections.length < 1 && graph.resolve_failures.length < 1 && graph.apply_order.length < 1) {
        log_info("Preflight passed without any found dependencies.")
    }

    // Surface failures (preflight + resolve + owner). If any are present, abort before apply.
    const root_pr = graph.nodes.get(graph.root_id ?? '')?.pr_meta;
    let failure_count = 0;
    for (const pf of graph.preflight_failures) {
        log_failure_block({
            title: 'Same-repo preflight failed',
            cause: pf.result.reason,
            pr_under_test: root_pr ? { id: root_pr.pr_id, url: root_pr.pr_url } : undefined,
            dep_pr: { id: pf.dep_url, url: pf.dep_url },
            extra: [['Detail', pf.result.detail]],
            hint: pf.result.reason === 'branch_not_synced'
                ? 'Update the PR branch from the default branch, then re-trigger this PR\'s CI.'
                : pf.result.reason === 'unmerged_same_repo'
                    ? 'Merge the required same-repo PR first; same-repo deps are not applied via artifacts.'
                    : 'Same-repo deps must target either the initial PR\'s branch or the default branch.',
        });
        failure_count++;
    }
    for (const rj of graph.owner_rejections) {
        log_failure_block({
            title: 'Cross-repo dep rejected',
            cause: 'external_owner_not_allowed',
            pr_under_test: root_pr ? { id: root_pr.pr_id, url: root_pr.pr_url } : undefined,
            dep_pr: { id: `${rj.dep_owner}/...`, url: rj.dep_url },
            extra: [['Owner', rj.dep_owner]],
            hint: 'Add the owner via --other_allowed_owner <owner>, or pass --allow_external_owners to disable enforcement.',
        });
        failure_count++;
    }
    for (const rf of graph.resolve_failures) {
        const node = graph.nodes.get(rf.node_id);
        log_failure_block({
            title: 'Artifact resolution failed',
            cause: rf.reason,
            pr_under_test: root_pr ? { id: root_pr.pr_id, url: root_pr.pr_url } : undefined,
            dep_pr: node?.pr_meta ? { id: node.pr_meta.pr_id, url: node.pr_meta.pr_url } : undefined,
            extra: [['Detail', rf.detail, rf.link]],
            hint: rf.reason === 'workflow_timeout'
                ? 'Re-trigger this PR\'s CI once the dep workflow has completed.'
                : rf.reason === 'workflow_failed'
                    ? 'Re-run the dep PR\'s workflow, then re-trigger this PR\'s CI.'
                    : rf.reason === 'daily_baseline_unknown'
                        ? 'This repo is not registered as a mod source and has no CI_INTEGRATION.SOURCE_OVERRIDES entry.'
                        : undefined,
        });
        failure_count++;
    }

    if (failure_count > 0) {
        log_err(`Aborting apply: ${failure_count} failure(s) during graph build.`);
        throw Error();
    }

    if (options.dry) {
        log_info(`Dry run: would apply ${tag_count(graph.apply_order.length)} node(s) in order:`);
        for (const id of graph.apply_order) log_info(`  ${tag_neutral(id)}`);
        return;
    }

    await apply_nodes_in_order(graph, { dry: options.dry, pack_variant_name: options.pack_variant_name }, mod_map);
    log_ok(`Applied ${tag_count(graph.apply_order.length)} node(s) successfully.`);
}

//#region pr_gate

export interface GateOptions {
    allow_external_owners?: boolean;
    other_allowed_owners?: string[];
    build_jobs?: string[];
}

const GATE_PASS_STATES: ReadonlySet<PRStateKind | 'default_commit'> = new Set(['merged_with_release']);

// Decide whether the given PR is safe to merge: every cross-repo dep must be merged + have a published release.
// Exit code 0 = mergeable, 1 = blocked. Uses process.exitCode so the full report still prints.
export async function pr_gate(source_url: string | undefined, options: GateOptions): Promise<void> {
    if (source_url == undefined) {
        log_err('Missing source url.');
        process.exitCode = 1;
        return;
    }
    assert_gh_key();
    log_debug(`Gate options: build_jobs=${(options.build_jobs ?? []).join(',') || '<none>'}, allow_external_owners=${options.allow_external_owners ?? false}, other_allowed_owners=[${(options.other_allowed_owners ?? []).join(', ')}]`);
    const mod_map = await read_saved_mods(ANNOTATED_FILE);
    const cache = new_gh_cache();

    const graph = await build_dep_graph(source_url, {
        build_jobs: options.build_jobs,
        allow_external_owners: options.allow_external_owners,
        other_allowed_owners: options.other_allowed_owners,
        skip_artifact_download: true,
    }, mod_map, cache);

    log_debug(`Graph built: ${graph.nodes.size} node(s), apply_order=[${graph.apply_order.join(', ')}], preflight_failures=${graph.preflight_failures.length}, owner_rejections=${graph.owner_rejections.length}, resolve_failures=${graph.resolve_failures.length}`);

    let blocked = false;
    log_info(`Gate report for ${tag_primary(source_url)}:`);
    for (const id of graph.apply_order) {
        const node = graph.nodes.get(id);
        if (node == undefined) continue;
        if (id === graph.root_id) continue;
        const state = node.state;
        if (GATE_PASS_STATES.has(state)) {
            log_ok(`  ${tag_neutral(id)} - ${state}`, node.release_html_url ?? node.pr_meta?.pr_url);
        } else {
            blocked = true;
            log_err(`  ${tag_neutral(id)} - ${state}`, node.release_html_url ?? node.pr_meta?.pr_url);
        }
    }

    for (const pf of graph.preflight_absorbed) {
        log_ok(`  ${tag_neutral(pf.dep_url)} - ${pf.result.reason}`);
    }

    for (const pf of graph.preflight_failures) {
        blocked = true;
        log_err(`  preflight ${pf.result.reason}: ${pf.dep_url}`);
    }
    for (const rj of graph.owner_rejections) {
        blocked = true;
        log_err(`  owner_rejected: ${rj.dep_url}`);
    }
    for (const rf of graph.resolve_failures) {
        // For gate, only daily_baseline_unknown is a hard block; resolve failures elsewhere are informational.
        if (rf.reason === 'daily_baseline_unknown') {
            blocked = true;
            log_err(`  ${rf.node_id} - daily_baseline_unknown: ${rf.detail}`);
        } else {
            log_warn(`  ${rf.node_id} - ${rf.reason}: ${rf.detail}`);
        }
    }

    if (blocked) {
        log_err(`Gate: BLOCKED - PR is not safe to merge.`);
        process.exitCode = 1;
    } else {
        log_ok(`Gate: MERGEABLE - all cross-repo deps merged with published releases.`);
    }
}

// Kept for external callers but unused inside this file - helper to inspect a single node's state.
export function _debug_node_states(graph: DepGraph): Array<{ id: string; state: DepNode['state'] }> {
    return Array.from(graph.nodes.values()).map((n) => ({ id: n.id, state: n.state }));
}
