import { query_gh_project_by_url } from '../../utils/fetch';
import { log_debug, log_info, tag_dim, tag_neutral } from '../../utils/log';
import type { GhCache, PRMeta } from './graph';

//#region Result types

export type PreflightFailureReason = 'unmerged_same_repo' | 'branch_not_synced' | 'unsupported_target_branch';
export type PreflightSuccessReason = 'absorbed_same_branch_merged' | 'absorbed_default_merge_present_in_branch';

export type PreflightResult =
    | { ok: true; reason: PreflightSuccessReason; detail: string; link: string }
    | { ok: false; reason: PreflightFailureReason; detail: string; link: string };

//#region Preflight

// Decide whether a same-repo dep is already present in the current PR's branch and can be skipped (absorbed),
// or if developer action is needed before resolution can proceed. Same-repo deps NEVER enter the dep graph -
// they either absorb cleanly or block the resolve.
export async function preflight_same_repo_dep(initial: PRMeta, dep: PRMeta, default_branch: string, cache: GhCache): Promise<PreflightResult> {
    const dep_base = dep.base.ref;
    log_debug(`Preflight: dep=${dep.pr_id} (base=${dep_base}), initial=${initial.pr_id} (head=${initial.head.ref}), default_branch=${default_branch}`);

    if (dep_base === initial.head.ref) {
        // Dep targets the same branch as the initial PR.
        if (dep.merged) {
            log_info(
                `Same-repo dep ${tag_neutral(dep.pr_id)} already merged into ${tag_neutral(initial.head.ref)}; absorbed, skipping graph entry.`,
                dep.pr_url,
            );
            return {
                ok: true,
                reason: 'absorbed_same_branch_merged',
                detail: `Dep PR ${dep.pr_id} is already merged into branch '${initial.head.ref}'.`,
                link: dep.pr_url,
            };
        }
        return {
            ok: false,
            reason: 'unmerged_same_repo',
            detail: `Dep PR ${dep.pr_id} targets the same branch '${initial.head.ref}' as ${initial.pr_id} but is not yet merged. The dep must be merged first.`,
            link: dep.pr_url,
        };
    }

    if (dep_base === default_branch) {
        // Dep targets default. Check whether the initial PR's branch already contains the dep's merge commit.
        if (!dep.merged || dep.merge_commit_sha == undefined) {
            return {
                ok: false,
                reason: 'unmerged_same_repo',
                detail: `Dep PR ${dep.pr_id} targets default branch '${default_branch}' but is not yet merged.`,
                link: dep.pr_url,
            };
        }
        const contains = await branch_contains_commit(initial, dep.merge_commit_sha, cache);
        if (contains) {
            log_info(
                `Same-repo dep ${tag_neutral(dep.pr_id)} merge commit ${tag_dim(dep.merge_commit_sha.slice(0, 7))} is reachable from ${tag_neutral(initial.pr_id)}'s branch; absorbed, skipping graph entry.`,
                dep.pr_url,
            );
            return {
                ok: true,
                reason: 'absorbed_default_merge_present_in_branch',
                detail: `Dep PR ${dep.pr_id} merge commit ${dep.merge_commit_sha.slice(0, 7)} is reachable from ${initial.pr_id}'s head.`,
                link: dep.pr_url,
            };
        }
        return {
            ok: false,
            reason: 'branch_not_synced',
            detail: `Dep PR ${dep.pr_id} is merged into '${default_branch}' but ${initial.pr_id}'s branch does not yet contain its merge commit (${dep.merge_commit_sha.slice(0, 7)}). Update the PR branch from default.`,
            link: initial.pr_url,
        };
    }

    return {
        ok: false,
        reason: 'unsupported_target_branch',
        detail: `Dep PR ${dep.pr_id} targets '${dep_base}', which is neither the initial PR's head branch nor default ('${default_branch}'). No defined resolution policy for arbitrary feature branches.`,
        link: dep.pr_url,
    };
}

//#region Helpers

// Use GH's /compare API to check if the initial PR's head contains the dep's merge commit.
// `status: 'identical' | 'ahead'` means the dep commit is reachable from initial.head.sha.
async function branch_contains_commit(initial: PRMeta, commit_sha: string, cache: GhCache): Promise<boolean> {
    const cache_key = `${initial.owner}/${initial.project} ${initial.head.sha}...${commit_sha}`;
    if (cache.compares.has(cache_key)) {
        log_debug(`compare cache hit: ${cache_key}`);
        const cached = cache.compares.get(cache_key);
        return cached.status === 'identical' || cached.status === 'behind';
    }

    // /compare/{base}...{head} reports status from base's perspective.
    // We want "is `commit_sha` reachable from initial.head.sha?" - that means compare(commit_sha...initial.head.sha)
    // where if the result is 'identical' or 'ahead', the head contains the base.
    const path = `/compare/${commit_sha}...${initial.head.sha}`;
    const { status, body } = await query_gh_project_by_url(initial.pr_url, path);
    if (status !== '200' || body == null) return false;
    cache.compares.set(cache_key, body);
    const compare_status = (body as any).status as string | undefined;
    return compare_status === 'identical' || compare_status === 'ahead';
}
