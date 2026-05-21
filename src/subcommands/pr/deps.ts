import { CI_INTEGRATION } from '../../utils/config';
import { assert_gh_key, download_file, query_gh_project_by_url, SOURCE_API_KEYS } from '../../utils/fetch';
import { collect_files_from_zip, extract_file_from_zip, is_zip_file } from '../../utils/fs';
import {
    log_debug,
    log_err,
    log_failure_block,
    log_info,
    log_ok,
    log_step,
    tag_count,
    tag_dim,
    tag_neutral,
    tag_primary,
} from '../../utils/log';
import { extract_required_prs, parse_gh_url } from '../../utils/sources';
import { hash_buffer } from '../../utils/utils';
import { preflight_same_repo_dep } from './preflight';
import { fetch_pr_meta, new_gh_cache, classify_pr_state, find_merged_prs_since_daily, read_mod_map, type GhCache, type PRMeta } from './graph';
import { type mod_object } from '../../utils/mods';
import { resolve_artifact_for_url, verify_uncertain_refs, type Artifact } from './resolve';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

export interface DepsOptions {
    target_dir: string;
    jar_suffix: string;
    dry?: boolean;
    build_jobs?: string[];
    artifact_name?: string;
    allow_failed_workflows?: boolean;
    allow_external_owners?: boolean;
    other_allowed_owners?: string[];
}

interface ManifestEntry {
    jar_path: string;
    repo_url: string;
    commit_sha: string;
    pr_url: string;
}

interface Manifest {
    dependencies: ManifestEntry[];
}

// A cross-repo dep with its resolved artifact, ready to be downloaded.
interface ResolvedDep {
    dep_url: string;
    pr_id: string;          // 'owner/project#N' for logs
    owner: string;
    project: string;
    artifact: Artifact;
    resolved_sha: string;
}

// Downloads cross-repo dependency JARs from first-layer PRs and builds a manifest JSON.
// Three phases: select cross-repo deps from root PR body, resolve every artifact upfront, then download + extract.
export async function pr_deps(source_url: string | undefined, options: DepsOptions): Promise<void> {
    if (source_url == undefined) {
        log_err('Missing source url.');
        throw Error();
    }
    assert_gh_key();
    const cache = new_gh_cache();

    log_info(`Fetching root PR metadata for ${tag_primary(source_url)}...`);
    const root_pr_meta = await fetch_pr_meta(source_url, cache);
    if (root_pr_meta == undefined) {
        log_err(`Could not fetch root PR metadata for ${source_url}`);
        throw Error();
    }

    // Phase 1: collect & dedupe cross-repo dep URLs.
    const selected_dep_urls = await select_cross_repo_deps(root_pr_meta, options, cache);
    if (selected_dep_urls.length === 0) {
        log_ok('No cross-repo dependency PRs found.');
        return;
    }

    // Phase 1.5: drop deps already covered by the daily baseline (merged_with_release at or before daily).
    const mod_map = await read_mod_map();
    const filtered_dep_urls = await filter_deps_already_in_daily(selected_dep_urls, mod_map, cache);
    if (filtered_dep_urls.length === 0) {
        log_ok('All cross-repo dependency PRs are already covered by the daily baseline.');
        return;
    }

    // Phase 2: resolve artifacts for every selected dep upfront. Collect all failures so a CI viewer
    // sees the full picture rather than stopping at the first miss.
    const resolved_deps = await resolve_all_dep_artifacts(filtered_dep_urls, root_pr_meta, options);

    if (options.dry) {
        const dry_manifest = {
            dependencies: resolved_deps.map((dep) => ({
                artifact_name: dep.artifact.name,
                repo_url: `https://github.com/${dep.owner}/${dep.project}`,
                commit_sha: dep.resolved_sha,
                pr_url: dep.dep_url,
            })),
        };
        console.log(JSON.stringify(dry_manifest, null, 4));
        return;
    }

    // Phase 3: download zips, verify integrity, extract jars, write manifest.
    await download_and_emit_manifest(resolved_deps, options);
}

//#region Phase 1: select cross-repo deps

// Parse root PR body, filter to cross-repo refs, enforce owner allowlist, and resolve repos with
// multiple required PRs via same-repo preflight absorption.
async function select_cross_repo_deps(root_pr_meta: PRMeta, options: DepsOptions, cache: GhCache): Promise<string[]> {
    log_step('Parsing root PR body for required PR refs...');
    const required_prs = await verify_uncertain_refs(extract_required_prs(root_pr_meta.body), root_pr_meta.owner, root_pr_meta.project);

    // Group cross-repo urls by 'owner/project' (lower-cased), deduping URL strings within each group.
    const groups = new Map<string, string[]>();
    let same_repo_dropped = 0;
    for (const match of required_prs) {
        for (const url of match.urls) {
            const parsed = parse_gh_url(url);
            if (!parsed) continue;
            if (parsed.owner.toLowerCase() === root_pr_meta.owner.toLowerCase()
                && parsed.project.toLowerCase() === root_pr_meta.project.toLowerCase()) {
                same_repo_dropped++;
                continue;
            }
            const key = `${parsed.owner.toLowerCase()}/${parsed.project.toLowerCase()}`;
            const bucket = groups.get(key);
            if (bucket == undefined) groups.set(key, [url]);
            else if (!bucket.includes(url)) bucket.push(url);
        }
    }
    if (same_repo_dropped > 0) {
        log_debug(`Skipped ${same_repo_dropped} same-repo PR ref(s); pr_deps handles cross-repo deps only.`);
    }

    const selected: string[] = [];
    for (const [repo_key, urls] of groups.entries()) {
        const sample = parse_gh_url(urls[0]!)!;
        enforce_owner_allowlist(sample, urls[0]!, root_pr_meta, options);

        if (urls.length === 1) {
            selected.push(urls[0]!);
            continue;
        }
        selected.push(await absorb_multi_pr_repo(repo_key, urls, root_pr_meta, cache));
    }
    return selected;
}

// Throw a structured failure if the dep owner is not on the allowlist.
function enforce_owner_allowlist(parsed: { owner: string; project: string; secondary?: string }, sample_url: string, root_pr_meta: PRMeta, options: DepsOptions): void {
    if (options.allow_external_owners) return;
    const allowed = parsed.owner.toLowerCase() === root_pr_meta.owner.toLowerCase()
        || (options.other_allowed_owners ?? []).some((o) => o.toLowerCase() === parsed.owner.toLowerCase());
    if (allowed) return;
    log_failure_block({
        title: 'Cross-repo dep rejected',
        cause: 'external_owner_not_allowed',
        pr_under_test: { id: root_pr_meta.pr_id, url: root_pr_meta.pr_url },
        dep_pr: { id: `${parsed.owner}/${parsed.project}#${parsed.secondary ?? '?'}`, url: sample_url },
        extra: [['Owner', parsed.owner]],
        hint: 'Add the owner via --other_allowed_owner <owner>, or pass --allow_external_owners to disable enforcement.',
    });
    throw Error();
}

// Multiple PRs from the same external repo: try to absorb one into another via same-repo preflight.
// Returns the surviving PR's URL; throws (with a structured failure block) if neither absorbs the other.
async function absorb_multi_pr_repo(repo_key: string, urls: string[], root_pr_meta: PRMeta, cache: GhCache): Promise<string> {
    log_step(`Checking multiple required PRs for repo ${tag_primary(repo_key)}...`);
    const metas: PRMeta[] = [];
    for (const url of urls) {
        const meta = await fetch_pr_meta(url, cache);
        if (meta == undefined) {
            log_err(`Failed to fetch PR metadata for ${url}`);
            throw Error();
        }
        metas.push(meta);
    }
    const default_branch = await resolve_default_branch(repo_key, urls[0]!, cache);

    const active = [...metas];
    let changed = true;
    while (changed && active.length > 1) {
        changed = false;
        outer: for (let i = 0; i < active.length; i++) {
            for (let j = 0; j < active.length; j++) {
                if (i === j) continue;
                const preflight_res = await preflight_same_repo_dep(active[i]!, active[j]!, default_branch, cache);
                if (preflight_res.ok) {
                    log_info(`Dedupe: ${tag_neutral(active[j]!.pr_id)} is absorbed by ${tag_primary(active[i]!.pr_id)}.`);
                    active.splice(j, 1);
                    changed = true;
                    break outer;
                }
            }
        }
    }
    if (active.length > 1) {
        log_failure_block({
            title: 'Ambiguous cross-repo deps',
            cause: 'multiple_unresolved_required_prs',
            pr_under_test: { id: root_pr_meta.pr_id, url: root_pr_meta.pr_url },
            hint: `The required PRs [${active.map((m) => m.pr_id).join(', ')}] cannot be reconciled because neither absorbs the other. Both may be open or un-synced.`,
        });
        throw Error();
    }
    return active[0]!.pr_url;
}

// Look up the default branch for a repo, honoring CI_INTEGRATION overrides; falls back to 'main'.
async function resolve_default_branch(repo_key: string, sample_url: string, cache: GhCache): Promise<string> {
    let repo_meta = cache.repo_meta.get(repo_key);
    if (repo_meta == undefined) {
        const res = await query_gh_project_by_url(sample_url, '');
        if (res.status === '200' && res.body != null) {
            repo_meta = res.body;
            cache.repo_meta.set(repo_key, repo_meta);
        }
    }
    return CI_INTEGRATION?.SOURCE_OVERRIDES?.[repo_key]?.default_branch
        ?? (repo_meta?.default_branch as string | undefined)
        ?? 'main';
}

//#region Phase 1.5: filter deps already in daily

// Returns the subset of dep_urls that are NOT already covered by the daily baseline.
// A dep is considered covered when it is merged_with_release AND its PR number does not appear in
// the merged-since-daily list (meaning it was merged at or before the baseline commit).
// Safe default: if the baseline is unknown for a repo, keep the dep.
async function filter_deps_already_in_daily(dep_urls: string[], mod_map: Map<string, mod_object>, cache: GhCache): Promise<string[]> {
    const kept: string[] = [];
    for (const dep_url of dep_urls) {
        const parsed = parse_gh_url(dep_url)!;
        const pr_id = `${parsed.owner}/${parsed.project}#${parsed.secondary}`;

        const classified = await classify_pr_state(dep_url, cache);
        if (classified == undefined || classified.state !== 'merged_with_release') {
            kept.push(dep_url);
            continue;
        }

        const since_daily = await find_merged_prs_since_daily(parsed.owner, parsed.project, mod_map, cache);
        if (!since_daily.ok) {
            log_debug(`Cannot determine daily baseline for ${parsed.owner}/${parsed.project}; keeping dep ${pr_id}.`);
            kept.push(dep_url);
            continue;
        }

        const pr_number = Number(parsed.secondary);
        const merged_after_baseline = since_daily.merged_prs.some((mpr) => mpr.pr_number === pr_number);
        if (!merged_after_baseline) {
            log_info(`Skipping ${tag_primary(pr_id)}: already merged with release ${tag_dim(classified.release_tag ?? '?')} at or before the daily baseline ${tag_dim(since_daily.daily_version)}.`);
            continue;
        }

        kept.push(dep_url);
    }
    return kept;
}

//#region Phase 2: resolve artifacts

// Resolve artifacts for every selected dep upfront. Collects all failures and surfaces them via
// log_failure_block before throwing, so a CI viewer can act on the full set in one pass.
async function resolve_all_dep_artifacts(dep_urls: string[], root_pr_meta: PRMeta, options: DepsOptions): Promise<ResolvedDep[]> {
    const resolved: ResolvedDep[] = [];
    let failures = 0;
    for (const dep_url of dep_urls) {
        const parsed = parse_gh_url(dep_url)!;
        const pr_id = `${parsed.owner}/${parsed.project}#${parsed.secondary}`;
        log_debug(`Resolving artifact for dependency PR ${tag_primary(pr_id)} ${tag_dim(`(${dep_url})`)}...`);
        const res = await resolve_artifact_for_url(dep_url, {
            build_jobs: options.build_jobs,
            artifact_name: options.artifact_name,
            allow_failed_workflows: options.allow_failed_workflows,
        });
        if (!res.ok) {
            log_failure_block({
                title: 'Artifact resolution failed',
                cause: res.reason,
                pr_under_test: { id: root_pr_meta.pr_id, url: root_pr_meta.pr_url },
                dep_pr: { id: pr_id, url: dep_url },
                extra: [['Detail', res.detail, res.link]],
                hint: res.reason === 'workflow_timeout'
                    ? 'Re-trigger CI once the dep workflow has completed.'
                    : res.reason === 'workflow_failed'
                        ? 'Re-run the dep PR\'s workflow.'
                        : undefined,
            });
            failures++;
            continue;
        }
        resolved.push({
            dep_url,
            pr_id,
            owner: parsed.owner,
            project: parsed.project,
            artifact: res.artifact,
            resolved_sha: res.resolved_sha,
        });
    }
    if (failures > 0) {
        log_err(`Aborting: ${tag_count(failures)} of ${tag_count(dep_urls.length)} dependency artifact(s) failed to resolve.`);
        throw Error();
    }
    return resolved;
}

//#region Phase 3: download, extract, write to manifest

// Create the destination dir, download each artifact zip, verify integrity, extract the matching jar,
// and write the final manifest JSON. The temp zips dir is always cleaned up via a finally block.
async function download_and_emit_manifest(resolved_deps: ResolvedDep[], options: DepsOptions): Promise<void> {
    const dest_dir = path.resolve(options.target_dir);
    const temp_zips_dir = path.join(dest_dir, '.tmp_zips');
    await mkdir(temp_zips_dir, { recursive: true });

    const escaped_suffix = options.jar_suffix.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const jar_pattern = new RegExp(escaped_suffix + '$', 'i');
    const manifest: Manifest = { dependencies: [] };
    const total = resolved_deps.length;

    try {
        for (let i = 0; i < resolved_deps.length; i++) {
            const dep = resolved_deps[i]!;
            const progress = `[${i + 1}/${total}]`;

            log_step(`${tag_count(progress)} Downloading ZIP ${tag_primary(dep.artifact.name)} ${tag_dim(`(${dep.pr_id})`)}...`);
            const zip_path = await download_and_verify_zip(dep, temp_zips_dir);

            const jar_files = (await collect_files_from_zip(zip_path, jar_pattern)) ?? [];
            if (jar_files.length < 1) {
                log_err(`Artifact zip ${dep.artifact.name} contains no files ending with '${options.jar_suffix}'.`);
                throw Error();
            } else if (jar_files.length > 1) {
                log_err(`Artifact zip ${dep.artifact.name} contains more than one file ending with '${options.jar_suffix}': [${jar_files.join(', ')}].`);
                throw Error();
            }

            const matched_file_in_zip = jar_files[0]!;
            const jar_filename = matched_file_in_zip.replace(/(?:.*?)([^\/]+?$)/, '$1');
            const target_jar_path = path.join(dest_dir, jar_filename);

            log_step(`${tag_count(progress)} Extracting ${tag_primary(jar_filename)}...`);
            const extracted_buffer = await extract_file_from_zip(zip_path, matched_file_in_zip);
            await Bun.write(target_jar_path, extracted_buffer);
            await rm(zip_path);

            manifest.dependencies.push({
                jar_path: target_jar_path,
                repo_url: `https://github.com/${dep.owner}/${dep.project}`,
                commit_sha: dep.resolved_sha,
                pr_url: dep.dep_url,
            });
        }

        const output_file = path.join(dest_dir, 'required_prs.json');
        log_info(`Writing manifest to ${tag_primary(output_file)}...`);
        await Bun.write(output_file, JSON.stringify(manifest, null, 4));
        log_ok(`Successfully downloaded and processed ${tag_count(total)} cross-repo dependency JAR(s).`);
    } finally {
        // force: true ignores ENOENT, so this is safe even if the dir was never created.
        await rm(temp_zips_dir, { recursive: true, force: true });
    }
}

// Download the dep's artifact zip into temp_zips_dir and verify size/checksum/zip-magic before returning its path.
async function download_and_verify_zip(dep: ResolvedDep, temp_zips_dir: string): Promise<string> {
    const zip_name = dep.artifact.name + '.zip';
    const zip_path = path.join(temp_zips_dir, zip_name);
    await download_file(
        dep.artifact.archive_download_url,
        'GITHUB',
        temp_zips_dir,
        zip_name,
        SOURCE_API_KEYS.get('GITHUB'),
    );

    const file = Bun.file(zip_path);
    if (!(await file.exists())) {
        log_err(`Failed to download file, is on disk missing.`, zip_path);
        throw Error();
    } else if (file.size !== dep.artifact.size_in_bytes) {
        log_err(`Size of downloaded file differs, got ${file.size} against expected ${dep.artifact.size_in_bytes}.`);
        throw Error();
    } else if ((await hash_buffer(await file.bytes(), 'sha256')) !== dep.artifact.digest) {
        log_err(`Checksum of file differs.`);
        throw Error();
    } else if (!(await is_zip_file(file))) {
        log_err(`Downloaded file matches expected but is not a zip file.`);
        throw Error();
    }
    return zip_path;
}
