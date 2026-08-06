import { query_gh_project_by_url } from '../../utils/fetch';
import { parse_gh_url } from '../../utils/sources';
import { read_saved_mods, type mod_object } from '../../utils/mods';
import { ANNOTATED_FILE, CI_INTEGRATION } from '../../utils/config';
import { extract_required_prs } from '../../utils/sources';
import { log_debug, log_info, log_step, log_warn, tag_count, tag_dim, tag_neutral, tag_primary } from '../../utils/log';
import { apply_github_artifact } from '../version';
import { preflight_same_repo_dep, type PreflightResult } from './preflight';
import { resolve_artifact_for_url, verify_uncertain_refs, type Artifact, type ResolveFailureReason } from './resolve';

//#region Types

export interface PRMeta {
    owner: string;
    project: string;
    pr_number: number;
    pr_id: string;          // 'owner/project#N'
    pr_url: string;
    merged: boolean;
    closed: boolean;
    merged_at?: string;
    merge_commit_sha?: string;
    head: { ref: string; sha: string };
    base: { ref: string };
    body: string;
}

export type PRStateKind = 'open' | 'closed_unmerged' | 'merged_with_release' | 'merged_unreleased' | 'merged_tag_unpublished';

export interface DepNode {
    id: string;                     // 'owner/project#N' for PR nodes, 'owner/project@sha' for default-commit nodes
    owner: string;
    project: string;
    pr_meta?: PRMeta;
    state: PRStateKind | 'default_commit';
    resolved_sha?: string;
    release_tag?: string;
    release_html_url?: string;
    artifact?: Artifact;
    dependencies: string[];         // node ids this one requires
}

export interface GhCache {
    pulls:     Map<string, any>;
    commits:   Map<string, any>;
    runs:      Map<string, any>;
    tags:      Map<string, string>;
    branches:  Map<string, any>;
    artifacts: Map<string, Artifact[]>;
    compares:  Map<string, any>;
    releases:  Map<string, any>;        // key = 'owner/project' -> release[]
    repo_meta: Map<string, any>;        // key = 'owner/project' -> repo metadata
}

export function new_gh_cache(): GhCache {
    return {
        pulls: new Map(),
        commits: new Map(),
        runs: new Map(),
        tags: new Map(),
        branches: new Map(),
        artifacts: new Map(),
        compares: new Map(),
        releases: new Map(),
        repo_meta: new Map(),
    };
}

export interface PreflightFailureRecord  { initial_pr_id: string; dep_url: string; result: PreflightResult; }
export interface PreflightAbsorbedRecord { initial_pr_id: string; dep_url: string; result: PreflightResult; }
export interface ResolveFailureRecord    { node_id: string; reason: ResolveFailureReason | 'daily_baseline_unknown'; detail: string; link?: string; }
export interface OwnerRejectionRecord    { from_pr_id: string; dep_owner: string; dep_url: string; }

export interface DepGraph {
    root_id?: string;
    nodes: Map<string, DepNode>;
    apply_order: string[];
    preflight_absorbed: PreflightAbsorbedRecord[];
    preflight_failures: PreflightFailureRecord[];
    resolve_failures:   ResolveFailureRecord[];
    owner_rejections:   OwnerRejectionRecord[];
}

export interface BuildOpts {
    build_jobs?: string[];
    artifact_name?: string[];
    allow_failed_workflows?: boolean;
    allow_external_owners?: boolean;
    other_allowed_owners?: string[];
    wait_timeout_ms?: number;
    poll_interval_ms?: number;
    skip_artifact_download?: boolean;
}

//#region PR metadata fetch + classify

// Fetch and cache the PR object for a given URL, returning a normalized PRMeta.
export async function fetch_pr_meta(pr_url: string, cache: GhCache): Promise<PRMeta | undefined> {
    const parsed = parse_gh_url(pr_url);
    if (!parsed || parsed.primary !== 'pull' || parsed.secondary == undefined) return undefined;
    const { owner, project } = parsed;
    const pr_number = Number(parsed.secondary);
    const cache_key = `${owner}/${project}#${pr_number}`;
    let body = cache.pulls.get(cache_key);
    if (body == undefined) {
        const res = await query_gh_project_by_url(pr_url, `/pulls/${pr_number}`);
        if (res.status !== '200' || res.body == null) return undefined;
        body = res.body;
        cache.pulls.set(cache_key, body);
    }
    return {
        owner,
        project,
        pr_number,
        pr_id: cache_key,
        pr_url,
        merged: Boolean(body.merged),
        closed: body.state === 'closed',
        merged_at: body.merged_at ?? undefined,
        merge_commit_sha: body.merge_commit_sha ?? undefined,
        head: { ref: body.head?.ref ?? '', sha: body.head?.sha ?? '' },
        base: { ref: body.base?.ref ?? '' },
        body: typeof body.body === 'string' ? body.body : '',
    };
}

// Resolve a release tag to a commit SHA via /git/refs/tags then annotated-tag hop if needed.
async function resolve_tag_to_sha(repo_url: string, tag: string, cache: GhCache): Promise<string | undefined> {
    const parsed = parse_gh_url(repo_url);
    if (!parsed) return undefined;
    const cache_key = `${parsed.owner}/${parsed.project}@tag=${tag}`;
    const cached = cache.tags.get(cache_key);
    if (cached != undefined) return cached;

    const ref_res = await query_gh_project_by_url(repo_url, `/git/refs/tags/${encodeURIComponent(tag)}`);
    if (ref_res.status !== '200' || ref_res.body == null) return undefined;
    const obj = (ref_res.body as any).object;
    if (obj == null) return undefined;
    let sha: string | undefined = obj.sha;
    if (obj.type === 'tag' && sha != undefined) {
        const tag_res = await query_gh_project_by_url(repo_url, `/git/tags/${sha}`);
        if (tag_res.status === '200' && tag_res.body != null && (tag_res.body as any).object?.sha != undefined) {
            sha = (tag_res.body as any).object.sha as string;
        }
    }
    if (sha != undefined) cache.tags.set(cache_key, sha);
    return sha;
}

// Look at /releases/tags/<tag> to see whether a release entry exists for the tag, and if it's drafted.
async function fetch_release_for_tag(repo_url: string, tag: string, cache: GhCache): Promise<{ exists: boolean; draft: boolean; html_url?: string } | undefined> {
    const parsed = parse_gh_url(repo_url);
    if (!parsed) return undefined;
    const res = await query_gh_project_by_url(repo_url, `/releases/tags/${encodeURIComponent(tag)}`, undefined, [404]);
    if (res.status === '404') return { exists: false, draft: false };
    if (res.status !== '200' || res.body == null) return undefined;
    return { exists: true, draft: Boolean((res.body as any).draft), html_url: (res.body as any).html_url };
}

/**
 * Classify the state of a PR: open, closed-without-merge, merged with published release, merged with tag-but-unpublished, or merged-unreleased.
 * 
 * Logic: 
 * 1. Fetch `/pulls/<n>` (cache by `owner/project#N`).
 * 2. If `merged === false` and `body.state === 'closed'` → `{ state: 'closed_unmerged' }`.
 * 3. If `merged === false` → `{ state: 'open' }`.
 * 4. If `merged === true`:
 *    - Walk releases (`/releases?per_page=100`) looking for one whose resolved tag commit equals `merge_commit_sha` OR whose `target_commitish` resolves to a SHA equal to `merge_commit_sha`. Tag→commit resolution per `AGENTS.md → Tag → commit resolution`.
 *    - If found and `draft === false` → `{ state: 'merged_with_release', release_tag, release_html_url }`.
 *    - If found but `draft === true`, OR a git tag exists (`/git/refs/tags/<tag>`) for the version-string but no release entry → `{ state: 'merged_tag_unpublished', tag }`.
 *    - Otherwise → `{ state: 'merged_unreleased' }`.
 */
export async function classify_pr_state(
    pr_url: string,
    cache: GhCache,
): Promise<{ pr: PRMeta; state: PRStateKind; release_tag?: string; release_html_url?: string } | undefined> {
    const pr = await fetch_pr_meta(pr_url, cache);
    if (pr == undefined) return undefined;
    log_debug(`Classifying ${pr.pr_id}: merged=${pr.merged}${pr.merge_commit_sha ? `, merge_sha=${pr.merge_commit_sha.slice(0, 7)}` : ''}`);

    if (!pr.merged) {
        if (pr.closed) {
            log_debug(`${pr.pr_id} -> closed_unmerged`);
            return { pr, state: 'closed_unmerged' };
        }
        log_debug(`${pr.pr_id} -> open`);
        return { pr, state: 'open' };
    }
    if (pr.merge_commit_sha == undefined) {
        log_debug(`${pr.pr_id} -> merged_unreleased (no merge_commit_sha)`);
        return { pr, state: 'merged_unreleased' };
    }

    // Search recent releases for one covering the merge commit.
    const repo_key = `${pr.owner}/${pr.project}`;
    let releases: any[] = cache.releases.get(repo_key) ?? [];
    if (releases.length === 0) {
        const res = await query_gh_project_by_url(pr_url, `/releases?per_page=100`);
        if (res.status === '200' && Array.isArray(res.body)) {
            releases = res.body as any[];
            cache.releases.set(repo_key, releases);
        }
    }

    for (const rel of releases) {
        const tag_name = rel.tag_name as string | undefined;
        if (tag_name == undefined) continue;
        const sha = await resolve_tag_to_sha(pr_url, tag_name, cache);
        if (sha === pr.merge_commit_sha) {
            if (rel.draft === true) {
                log_debug(`${pr.pr_id} -> merged_tag_unpublished (tag=${tag_name}, draft)`);
                return { pr, state: 'merged_tag_unpublished', release_tag: tag_name, release_html_url: rel.html_url };
            }
            log_debug(`${pr.pr_id} -> merged_with_release (tag=${tag_name})`);
            return { pr, state: 'merged_with_release', release_tag: tag_name, release_html_url: rel.html_url };
        }
    }

    // No release covers the merge commit. Last check: does a git tag exist somewhere referencing this commit
    // but with no release? That's tag_unpublished too. Cheap heuristic - skip this for now and report merged_unreleased.
    log_debug(`${pr.pr_id} -> merged_unreleased (no release found across ${releases.length} release(s))`);
    return { pr, state: 'merged_unreleased' };
}

//#region Merged-since-daily

let cached_repo_to_mods: Map<string, mod_object[]> | undefined;

function build_repo_to_mods(mod_map: Map<string, mod_object>): Map<string, mod_object[]> {
    if (cached_repo_to_mods != undefined) return cached_repo_to_mods;
    const out = new Map<string, mod_object[]>();
    for (const mod of mod_map.values()) {
        if (mod.update_state?.source_type !== 'GITHUB' || !mod.source) continue;
        const parsed = parse_gh_url(mod.source);
        if (!parsed) continue;
        const key = `${parsed.owner}/${parsed.project}`;
        if (!out.has(key)) out.set(key, []);
        out.get(key)!.push(mod);
    }
    cached_repo_to_mods = out;
    return out;
}

// Pick the mod with the newest last_updated_at, warning if versions diverge across mods from the same repo.
function pick_baseline_mod(repo_key: string, mods: mod_object[]): mod_object | undefined {
    if (mods.length === 0) return undefined;
    const sorted = [...mods].sort((a, b) => (b.update_state.last_updated_at ?? '').localeCompare(a.update_state.last_updated_at ?? ''));
    const newest = sorted[0]!;
    const versions = new Set(sorted.map((m) => m.update_state.version ?? ''));
    if (versions.size > 1) {
        log_warn(`Mods from repo ${repo_key} have divergent versions in ANNOTATED_FILE; using newest by last_updated_at (${newest.update_state.version}).`);
    }
    return newest;
}

/**
 * Returns the list of PRs merged into the default branch of (owner, project) since the daily baseline.
 * 
 * 1. Build (and cache on `mod_map` via a `WeakMap` if reuse is observed) `Map<"owner/project", mod_object[]>` once.
 * 2. Look up the entry for `(owner, project)`. Pick the mod whose `update_state.last_updated_at` is newest. `log_warn` if multiple mods from the same repo disagree on `update_state.version`.
 * 3. `update_state.version` is the release tag name. Resolve to commit SHA via `/git/refs/tags/<tag>` (+ optional `/git/tags/<sha>` for annotated).
 * 4. If `CI_INTEGRATION.SOURCE_OVERRIDES["owner/project"].daily_version_override` is set, use that string instead of the derived tag.
 * 5. If no mod entry exists AND no override is set → return `{ ok: false, reason: 'daily_baseline_unknown' }` with a message that mentions the TBD path:
 *    > "Repo `owner/project` is referenced as a dep but is not registered as a mod source. Future work: support config-only repos via `CI_INTEGRATION.SOURCE_OVERRIDES.owner/project.daily_version_override`. For now this is a hard failure."
 * 6. List PRs merged into the default branch with `merged_at > baseline_commit.committer.date`. Use paginated `/pulls?state=closed&base=<default_branch>&sort=updated&direction=desc&per_page=100`; stop when a page's tail entry's `merged_at <= baseline_commit.committer.date`.
 * 7. Return PR numbers + merge commit + body for downstream `extract_required_prs`.
 */
export async function find_merged_prs_since_daily(
    owner: string,
    project: string,
    mod_map: Map<string, mod_object>,
    cache: GhCache,
): Promise<
    | { ok: true; daily_version: string; daily_commit_sha: string; merged_prs: Array<{ pr_number: number; merge_commit_sha: string; merged_at: string; html_url: string; body: string }> }
    | { ok: false; reason: 'daily_baseline_unknown'; detail: string }
> {
    const repo_key = `${owner}/${project}`;
    const repo_url = `https://github.com/${owner}/${project}`;

    // Find the daily baseline version - either from CI_INTEGRATION override or from mod_map.
    let baseline_version: string | undefined = CI_INTEGRATION?.SOURCE_OVERRIDES?.[repo_key]?.daily_version_override;
    let baseline_mod: mod_object | undefined;
    if (baseline_version == undefined) {
        const repo_to_mods = build_repo_to_mods(mod_map);
        const mods = repo_to_mods.get(repo_key);
        log_debug(`Repository ${repo_key} is upstream for mod ${mods}`)
        if (mods == undefined) {
            return {
                ok: false,
                reason: 'daily_baseline_unknown',
                detail:
                    `Repo ${repo_key} is referenced as a dep but is not registered as a mod source in ANNOTATED_FILE. ` +
                    `Future work: support config-only repos via CI_INTEGRATION.SOURCE_OVERRIDES.${repo_key}.daily_version_override. ` +
                    `For now this is a hard failure.`,
            };
        }
        baseline_mod = pick_baseline_mod(repo_key, mods);
        baseline_version = baseline_mod?.update_state.version;
    }
    if (baseline_version == undefined) {
        return { ok: false, reason: 'daily_baseline_unknown', detail: `Could not derive a daily baseline version for ${repo_key}.` };
    }

    // Resolve tag -> commit -> date.
    let baseline_sha = await resolve_tag_to_sha(repo_url, baseline_version, cache);
    if (baseline_sha == undefined && baseline_mod?.update_state.sha256_sum) {
        // Tag stored in mod_map not found on GitHub — fall back to digest scan of recent releases.
        log_debug(`Tag '${baseline_version}' not found in ${repo_key}; falling back to digest scan of recent releases.`);
        const scan_res = await query_gh_project_by_url(repo_url, `/releases?per_page=50`);
        if (scan_res.status === '200' && Array.isArray(scan_res.body)) {
            const sha_sum = baseline_mod.update_state.sha256_sum;
            const matched_rel = (scan_res.body as any[]).find((rel) =>
                Array.isArray(rel.assets) &&
                rel.assets.some((a: any) => typeof a.digest === 'string' && a.digest.slice(7) === sha_sum),
            );
            if (matched_rel?.tag_name != undefined) {
                log_debug(`Digest scan matched release tag '${matched_rel.tag_name}' for ${repo_key}; retrying tag resolution.`);
                baseline_version = matched_rel.tag_name as string;
                baseline_sha = await resolve_tag_to_sha(repo_url, baseline_version, cache);
            }
        }
    }
    if (baseline_sha == undefined) {
        return { ok: false, reason: 'daily_baseline_unknown', detail: `Could not resolve tag '${baseline_version}' to a commit in ${repo_key}.` };
    }
    let baseline_commit = cache.commits.get(`${repo_key}@${baseline_sha}`);
    if (baseline_commit == undefined) {
        const res = await query_gh_project_by_url(repo_url, `/commits/${baseline_sha}`);
        if (res.status !== '200' || res.body == null) {
            return { ok: false, reason: 'daily_baseline_unknown', detail: `Could not fetch baseline commit ${baseline_sha} in ${repo_key}.` };
        }
        baseline_commit = res.body;
        cache.commits.set(`${repo_key}@${baseline_sha}`, baseline_commit);
    }
    const baseline_date: string = baseline_commit?.commit?.committer?.date ?? baseline_commit?.commit?.author?.date ?? '';
    if (baseline_date === '') {
        return { ok: false, reason: 'daily_baseline_unknown', detail: `Baseline commit ${baseline_sha} has no committer date.` };
    }

    // Determine default branch (cached).
    let repo_meta = cache.repo_meta.get(repo_key);
    if (repo_meta == undefined) {
        const res = await query_gh_project_by_url(repo_url, '');
        if (res.status === '200' && res.body != null) {
            repo_meta = res.body;
            cache.repo_meta.set(repo_key, repo_meta);
        }
    }
    const default_branch: string = CI_INTEGRATION?.SOURCE_OVERRIDES?.[repo_key]?.default_branch ?? (repo_meta?.default_branch as string | undefined) ?? 'main';
    log_debug(`Baseline for ${repo_key}: version=${baseline_version}, sha=${baseline_sha.slice(0, 7)}, date=${baseline_date}, default_branch=${default_branch}`);

    // Paginate merged PRs into default since baseline_date.
    const merged_prs: Array<{ pr_number: number; merge_commit_sha: string; merged_at: string; html_url: string; body: string }> = [];
    let page = 1;
    while (true) {
        const res = await query_gh_project_by_url(repo_url, `/pulls?state=closed&base=${encodeURIComponent(default_branch)}&sort=updated&direction=desc&per_page=100&page=${page}`);
        if (res.status !== '200' || !Array.isArray(res.body)) break;
        const page_body = res.body as any[];
        if (page_body.length === 0) break;
        let page_had_relevant = false;
        for (const pr of page_body) {
            const merged_at: string | undefined = pr.merged_at;
            if (!merged_at) continue; // closed but not merged
            if (merged_at <= baseline_date) continue;
            page_had_relevant = true;
            merged_prs.push({
                pr_number: pr.number,
                merge_commit_sha: pr.merge_commit_sha,
                merged_at,
                html_url: pr.html_url,
                body: typeof pr.body === 'string' ? pr.body : '',
            });
        }
        // If the page's last entry is at or before baseline AND no page entry was relevant, stop.
        const last_entry = page_body[page_body.length - 1];
        const last_merged_at: string | undefined = last_entry?.merged_at ?? last_entry?.closed_at;
        if (last_merged_at != undefined && last_merged_at <= baseline_date && !page_had_relevant) break;
        if (page_body.length < 100) break;
        page++;
        if (page > 10) {
            log_warn(`find_merged_prs_since_daily ${repo_key} reached page cap (10); stopping pagination.`);
            break;
        }
    }
    log_step(`Found ${tag_count(merged_prs.length)} merged PR(s) in ${tag_primary(repo_key)} since baseline ${tag_dim(baseline_version)} ${tag_dim(`(${baseline_date})`)}.`);
    return { ok: true, daily_version: baseline_version, daily_commit_sha: baseline_sha, merged_prs };
}

//#region Build graph

// DFS-build the dependency graph starting from root_pr_url.
export async function build_dep_graph(root_pr_url: string, opts: BuildOpts, mod_map: Map<string, mod_object>, cache?: GhCache): Promise<DepGraph> {
    log_debug(`build_dep_graph: root=${root_pr_url}, skip_artifact_download=${opts.skip_artifact_download ?? false}, build_jobs=${opts.build_jobs?.join(',') ?? '<none>'}`);
    cache = cache ?? new_gh_cache();
    const graph: DepGraph = {
        nodes: new Map(),
        apply_order: [],
        preflight_absorbed: [],
        preflight_failures: [],
        resolve_failures: [],
        owner_rejections: [],
    };
    const traced = new Set<string>();

    const root_classify = await classify_pr_state(root_pr_url, cache);
    if (root_classify == undefined) {
        log_warn(`Could not classify root PR ${root_pr_url}; aborting graph build.`);
        return graph;
    }
    const root_node = make_pr_node(root_classify);
    graph.nodes.set(root_node.id, root_node);
    graph.root_id = root_node.id;
    traced.add(root_node.id);

    await expand_pr_node(root_node, graph, traced, opts, mod_map, cache);
    log_debug(`DFS complete: ${graph.nodes.size} node(s) in graph.`);

    // Resolve artifacts unless caller said to skip (pr gate path).
    if (!opts.skip_artifact_download) {
        for (const node of graph.nodes.values()) {
            await resolve_node_artifact(node, graph, opts);
        }
    }

    // Dedupe and topo sort.
    dedupe_graph_by_newest_commit(graph, cache);
    graph.apply_order = topo_postorder(graph);
    log_debug(`Apply order (${graph.apply_order.length}): ${graph.apply_order.join(' -> ') || '<empty>'}`);
    return graph;
}

function make_pr_node(c: { pr: PRMeta; state: PRStateKind; release_tag?: string; release_html_url?: string }): DepNode {
    return {
        id: c.pr.pr_id,
        owner: c.pr.owner,
        project: c.pr.project,
        pr_meta: c.pr,
        state: c.state,
        resolved_sha: c.pr.merge_commit_sha ?? c.pr.head.sha,
        release_tag: c.release_tag,
        release_html_url: c.release_html_url,
        dependencies: [],
    };
}

// Expand a PR node: process required_prs from body, plus walk merged-since-daily for cross-repo deps.
async function expand_pr_node(node: DepNode, graph: DepGraph, traced: Set<string>, opts: BuildOpts, mod_map: Map<string, mod_object>, cache: GhCache): Promise<void> {
    if (node.pr_meta == undefined) return;
    const initial = node.pr_meta;

    // Determine default branch for the initial PR's repo (used by preflight).
    const repo_key = `${node.owner}/${node.project}`;
    let repo_meta = cache.repo_meta.get(repo_key);
    if (repo_meta == undefined) {
        const res = await query_gh_project_by_url(initial.pr_url, '');
        if (res.status === '200' && res.body != null) {
            repo_meta = res.body;
            cache.repo_meta.set(repo_key, repo_meta);
        }
    }
    const default_branch: string = CI_INTEGRATION?.SOURCE_OVERRIDES?.[repo_key]?.default_branch ?? (repo_meta?.default_branch as string | undefined) ?? 'main';

    const required = await verify_uncertain_refs(extract_required_prs(initial.body), node.owner, node.project);
    log_debug(`Expanding ${node.id}: ${required.length} required PR match(es) in body, default_branch=${default_branch}`);
    for (const match of required) {
        for (const dep_url of match.urls) {
            const dep_parsed = parse_gh_url(dep_url);
            if (!dep_parsed || dep_parsed.primary !== 'pull' || dep_parsed.secondary == undefined) {
                log_warn(`Skipping unparseable required PR ref: ${dep_url}`);
                continue;
            }
            const same_repo = dep_parsed.owner === initial.owner && dep_parsed.project === initial.project;
            log_debug(`  ${dep_parsed.owner}/${dep_parsed.project}#${dep_parsed.secondary}: ${same_repo ? 'same-repo' : `cross-repo (owner=${dep_parsed.owner})`}`);

            if (same_repo) {
                const dep_classify = await classify_pr_state(dep_url, cache);
                if (dep_classify == undefined) {
                    log_warn(`Could not classify same-repo dep ${dep_url}; skipping preflight.`);
                    continue;
                }
                const preflight_res = await preflight_same_repo_dep(initial, dep_classify.pr, default_branch, cache);
                if (!preflight_res.ok) {
                    graph.preflight_failures.push({ initial_pr_id: initial.pr_id, dep_url, result: preflight_res });
                } else {
                    graph.preflight_absorbed.push({ initial_pr_id: initial.pr_id, dep_url, result: preflight_res });
                }
                // Pass or fail, same-repo deps NEVER enter the dep graph.
                continue;
            }

            // Cross-repo: owner enforcement first.
            if (!opts.allow_external_owners) {
                const root_node = graph.nodes.get(graph.root_id!);
                const root_owner = root_node?.owner ?? initial.owner;
                const allowed = dep_parsed.owner.toLowerCase() === root_owner.toLowerCase()
                    || (opts.other_allowed_owners ?? []).some((o) => o.toLowerCase() === dep_parsed.owner.toLowerCase());
                if (!allowed) {
                    graph.owner_rejections.push({ from_pr_id: initial.pr_id, dep_owner: dep_parsed.owner, dep_url });
                    log_warn(`Cross-repo dep ${dep_url} rejected: owner '${dep_parsed.owner}' not in allowlist. Pass --allow_external_owners to override.`);
                    continue;
                }
            }

            const dep_id = `${dep_parsed.owner}/${dep_parsed.project}#${dep_parsed.secondary}`;
            if (traced.has(dep_id)) {
                log_debug(`  ${dep_id} already traced; adding dep edge only`);
                node.dependencies.push(dep_id);
                continue;
            }
            traced.add(dep_id);

            const dep_classify = await classify_pr_state(dep_url, cache);
            if (dep_classify == undefined) {
                log_warn(`Could not classify cross-repo dep ${dep_url}; skipping.`);
                continue;
            }
            const dep_node = make_pr_node(dep_classify);
            graph.nodes.set(dep_node.id, dep_node);
            node.dependencies.push(dep_node.id);

            // Walk merged-since-daily for the dep's repo. Adds extra nodes as deps of THIS node (the parent that
            // triggered the cross-repo expansion) - dedupe handles same-repo collisions later.
            const since_daily = await find_merged_prs_since_daily(dep_parsed.owner, dep_parsed.project, mod_map, cache);
            if (!since_daily.ok) {
                graph.resolve_failures.push({ node_id: dep_node.id, reason: since_daily.reason, detail: since_daily.detail });
            } else {
                for (const mpr of since_daily.merged_prs) {
                    const mpr_id = `${dep_parsed.owner}/${dep_parsed.project}#${mpr.pr_number}`;
                    if (traced.has(mpr_id)) {
                        log_debug(`  ${mpr_id} (merged-since-daily) already traced; adding dep edge only`);
                        node.dependencies.push(mpr_id);
                        continue;
                    }
                    traced.add(mpr_id);
                    const mpr_url = `https://github.com/${dep_parsed.owner}/${dep_parsed.project}/pull/${mpr.pr_number}`;
                    const mpr_classify = await classify_pr_state(mpr_url, cache);
                    if (mpr_classify == undefined) continue;
                    const mpr_node = make_pr_node(mpr_classify);
                    graph.nodes.set(mpr_node.id, mpr_node);
                    node.dependencies.push(mpr_node.id);
                    await expand_pr_node(mpr_node, graph, traced, opts, mod_map, cache);
                }
            }

            // Recurse into the explicit dep PR's body.
            await expand_pr_node(dep_node, graph, traced, opts, mod_map, cache);
        }
    }
}

// Resolve an artifact for a node based on its state.
async function resolve_node_artifact(node: DepNode, graph: DepGraph, opts: BuildOpts): Promise<void> {
    if (node.state === 'merged_tag_unpublished') {
        graph.resolve_failures.push({
            node_id: node.id,
            reason: 'workflow_failed' as ResolveFailureReason,
            detail: `Tag ${node.release_tag ?? '?'} exists for ${node.id} but the release is not published.`,
            link: node.release_html_url ?? node.pr_meta?.pr_url,
        });
        return;
    }
    if (node.pr_meta == undefined) return;

    const resolve_res = await resolve_artifact_for_url(node.pr_meta.pr_url, {
        build_jobs: opts.build_jobs,
        artifact_name: opts.artifact_name,
        allow_failed_workflows: opts.allow_failed_workflows,
        wait_timeout_ms: opts.wait_timeout_ms,
        poll_interval_ms: opts.poll_interval_ms,
    });
    if (resolve_res.ok) {
        node.artifact = resolve_res.artifact;
        node.resolved_sha = resolve_res.resolved_sha || node.resolved_sha;
    } else {
        graph.resolve_failures.push({ node_id: node.id, reason: resolve_res.reason, detail: resolve_res.detail, link: resolve_res.link });
    }
}

//#region Dedupe + topo apply

// Group nodes by (owner, project); for groups with > 1 node, keep the one with the newest resolved_sha commit date.
// Drops the other nodes from graph.nodes and redirects incoming dependency edges to the survivor.
export function dedupe_graph_by_newest_commit(graph: DepGraph, cache: GhCache): void {
    const by_repo: Map<string, DepNode[]> = new Map();
    for (const node of graph.nodes.values()) {
        const key = `${node.owner}/${node.project}`;
        if (!by_repo.has(key)) by_repo.set(key, []);
        by_repo.get(key)!.push(node);
    }

    const redirects = new Map<string, string>();    // dropped id -> survivor id
    for (const [repo_key, nodes] of by_repo.entries()) {
        if (nodes.length < 2) continue;
        // Pick survivor by commit date if we have it cached, else by resolved_sha lexical (stable).
        const dated = nodes.map((n) => ({ node: n, date: cache.commits.get(`${repo_key}@${n.resolved_sha ?? ''}`)?.commit?.committer?.date ?? '' }));
        dated.sort((a, b) => b.date.localeCompare(a.date));
        const survivor = dated[0]!.node;
        for (let i = 1; i < dated.length; i++) {
            const dropped = dated[i]!.node;
            if (dropped.id === graph.root_id) {
                // Never drop the root node, swap roles.
                redirects.set(survivor.id, dropped.id);
                continue;
            }
            redirects.set(dropped.id, survivor.id);
            // Merge dropped's deps into survivor (uniquely).
            for (const dep of dropped.dependencies) if (!survivor.dependencies.includes(dep)) survivor.dependencies.push(dep);
            graph.nodes.delete(dropped.id);
            log_info(`Dedupe: ${tag_neutral(dropped.id)} dropped in favor of ${tag_primary(survivor.id)} (newer commit on linear default branch).`);
        }
    }
    // Apply redirects to all remaining nodes' dependency lists.
    if (redirects.size > 0) {
        for (const node of graph.nodes.values()) {
            node.dependencies = Array.from(new Set(node.dependencies.map((d) => redirects.get(d) ?? d).filter((d) => d !== node.id)));
        }
    }
}

// Postorder DFS topological apply order, starting from root. Iteratively builds the order so deps come before the node.
export function topo_postorder(graph: DepGraph): string[] {
    if (graph.root_id == undefined || !graph.nodes.has(graph.root_id)) return [];
    const visited = new Set<string>();
    const order: string[] = [];
    function visit(id: string) {
        if (visited.has(id)) return;
        visited.add(id);
        const node = graph.nodes.get(id);
        if (node == undefined) return;
        for (const dep of node.dependencies) visit(dep);
        order.push(id);
    }
    visit(graph.root_id);
    // Also include any nodes that weren't reached from root (shouldn't happen, but be defensive).
    for (const id of graph.nodes.keys()) if (!visited.has(id)) visit(id);
    return order;
}

// Apply artifacts in graph.apply_order using version.ts's apply_github_artifact.
export async function apply_nodes_in_order(graph: DepGraph, options: { dry: boolean; pack_variant_name?: string }, mod_map: Map<string, mod_object>): Promise<void> {
    for (const id of graph.apply_order) {
        const node = graph.nodes.get(id);
        if (node == undefined) continue;
        if (node.artifact == undefined) {
            log_warn(`Node ${id} has no artifact; skipping apply.`);
            continue;
        }
        log_step(`Applying ${tag_primary(node.id)}${node.release_tag ? ` ${tag_dim(`(release ${node.release_tag})`)}` : ''}...`);
        await apply_github_artifact(node.artifact, options, mod_map);
    }
}

// Helper for orchestrators that want a fresh mod_map alongside the graph build.
export async function read_mod_map(): Promise<Map<string, mod_object>> {
    return read_saved_mods(ANNOTATED_FILE);
}
