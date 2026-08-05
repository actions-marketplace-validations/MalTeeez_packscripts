import fs from 'fs';
import {
    ANNOTATED_FILE,
    CONFIG_FILE,
    MOD_BASE_DIR,
    PACKAGING,
    RELATIVE_INSTANCE_DIRECTORY,
    read_intermediate_config,
    set_config_keys,
    type PackagingConfig,
    type PackPackagingVariant,
} from '../utils/config';
import { mkdir, rm } from 'node:fs/promises';
import { download_file } from '../utils/fetch';
import { expandOid, readBlob, resolveRef, TREE, walk } from 'isomorphic-git';
import { git_diff_tree, git_list_tree, git_read_blob_at, git_resolve_ref, is_git_available, type git_tree_diff_entry } from '../utils/git';
import { bundle_files_to_zip, path_is_directory } from '../utils/fs';
import { sync } from 'fast-glob';
import { CLIColor, finish_live_zone, hash_buffer, init_live_zone, update_live_zone } from '../utils/utils';
import { read_saved_mods, type mod_object } from '../utils/mods';
import { input, confirm } from '@inquirer/prompts';
import { parse_gh_url } from '../utils/sources';

interface bootstrap_json {
    unsup_manifest: string;
    version: {
        name: string;
        code: number;
    };
    hash_function: string;
    files: Array<{
        path: string;
        hash: string;
        size: number;
        url: string;
        mirror_url?: string;
    }>;
}

interface manifest_json {
    unsup_manifest: string;
    name: string;
    versions: {
        current: {
            name: string;
            code: number;
        };
        history: {
            name: string;
            code: number;
        }[];
    };
}

interface version_json {
    unsup_manifest: string;
    hash_function: string;
    changes: {
        path: string;
        from_hash: string | null;
        from_size: number;
        to_hash: string | null;
        to_size: number;
        url?: string;
        mirror_url?: string;
    }[];
    component_versions: {
        [key: string]: string;
    };
}

//#region git worker pool
function create_worker_pool(total: number, worker_count: number, options: { live_render?: boolean } = {}) {
    const { live_render = true } = options;
    let completed = 0;
    const worker_status = Array.from({ length: worker_count }, () => 'idle');

    const render = () => {
        if (!live_render) return;
        const bar_width = 40;
        const filled = Math.round((completed / total) * bar_width);
        const bar = CLIColor.FgGreen + '▓'.repeat(filled) + CLIColor.FgGray8 + '░'.repeat(bar_width - filled) + CLIColor.Reset;
        const percent = String(Math.round((completed / total) * 100)).padStart(3);
        const progress_line = `  ${bar} ${CLIColor.FgWhite}${percent}%${CLIColor.Reset} ${CLIColor.FgGray11}(${completed}/${total})${CLIColor.Reset}`;

        update_live_zone([
            progress_line,
            '',
            ...worker_status.map((status, i) => {
                if (status === 'idle') {
                    return `  ${CLIColor.FgGray8}worker ${i + 1}  idle${CLIColor.Reset}`;
                }
                const [change_type, ...rest] = status.split(' ');
                const filepath = rest.join(' ');
                const type_color =
                    change_type === 'added'
                        ? CLIColor.FgGreen
                        : change_type === 'deleted'
                          ? CLIColor.FgRed
                          : change_type === 'modified'
                            ? CLIColor.FgYellow
                            : CLIColor.FgCyan;
                const label = filepath
                    ? `${type_color}${change_type}${CLIColor.Reset}  ${CLIColor.FgGray15}${filepath}${CLIColor.Reset}`
                    : `${type_color}${change_type}${CLIColor.Reset}`;
                return `  ${CLIColor.FgCyan}worker ${i + 1}${CLIColor.Reset}  ${label}`;
            }),
        ]);
    };

    const set_status = (worker_id: number, status: string) => {
        worker_status[worker_id] = status;
        render();
    };

    const complete = (worker_id: number) => {
        completed++;
        worker_status[worker_id] = 'idle';
        render();
    };

    const start = () => {
        if (live_render) {
            init_live_zone(worker_count + 2);
            render();
        }
    };

    const finish = (summary: string | undefined) => {
        if (live_render) finish_live_zone();
        if (summary) console.info(summary);
    };

    return { start, finish, set_status, complete };
}

//#region general helpers
/**
 * Walk a commits tree with isomorphic-git, for when the git binary isn't available.
 * Can't read packfiles > 2 GiB, see utils/git.ts.
 */
async function walk_tree_oids_with_isomorphic_git(commit_sha: string): Promise<Map<string, string>> {
    const file_oids: Map<string, string> = new Map();

    await walk({
        fs: fs,
        dir: RELATIVE_INSTANCE_DIRECTORY,
        trees: [TREE({ ref: commit_sha })],
        map: async (filepath, [entry]) => {
            if (!entry) return null;
            const type = await entry.type();
            if (type === 'tree') return undefined;
            file_oids.set(filepath, await entry.oid());
            return null;
        },
    });

    return file_oids;
}

/**
 * Diff two commits with isomorphic-git, for when the git binary isn't available.
 * Can't read packfiles > 2 GiB, see utils/git.ts.
 */
async function diff_trees_with_isomorphic_git(base_commit_sha: string, target_commit_sha: string): Promise<git_tree_diff_entry[]> {
    return await walk({
        fs: fs,
        dir: RELATIVE_INSTANCE_DIRECTORY,
        trees: [TREE({ ref: base_commit_sha }), TREE({ ref: target_commit_sha })],
        map: async (filepath, [a, b]) => {
            if (filepath === '.') return;

            const type = await (a ?? b)?.type();
            if (type === 'tree') return;

            const a_oid = await a?.oid();
            const b_oid = await b?.oid();

            if (a_oid === b_oid) return;

            return {
                filepath,
                status: !a ? 'added' : !b ? 'deleted' : 'modified',
                old_oid: a_oid,
                new_oid: b_oid,
            };
        },
    });
}

async function get_lfs_oids(dir: string, target_commits: string[]): Promise<Map<string, { hash: string; size: number }>> {
    const lfs_files = new Map<string, { hash: string; size: number }>();

    for (const commit_sha of target_commits) {
        const check = Bun.spawn(['git', 'lfs', 'ls-files', '-d', commit_sha], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
        const [out] = await Promise.all([new Response(check.stdout).text(), new Response(check.stderr).text()]);
        await check.exited;

        // Non-zero exit means either git-lfs isn't installed or repo has no LFS — either way, empty map is correct
        if (check.exitCode !== 0 || !out.trim()) return lfs_files;

        for (const block of out.split('\n\n')) {
            const path = block.match(/^ *filepath: (.+)$/m)?.[1]?.trim();
            const hash = block.match(/^ *oid: sha256 ([a-f0-9]{64})$/m)?.[1];
            const size = block.match(/^ *size: (\d+)$/m)?.[1];
            if (path && hash && size) {
                lfs_files.set(path + ':' + commit_sha, { hash, size: parseInt(size, 10) });
            }
        }
    }

    if (lfs_files.size > 0) {
        const short_hashes = target_commits.map((sha) => sha.slice(0, 7)).join(', ');
        console.log(
            `Found ${lfs_files.size} LFS objects in ${target_commits.length == 1 ? short_hashes : '[' + short_hashes + ']'}, caching.`,
        );
    }

    return lfs_files;
}

/**
 * Instead of going through isomorphic-git, try directly going through a subprocess via the git binary.
 * Should be faster, and seems to work most of the time.
 *
 * LFS files are handled via the pre-built lfs_oids map — if the filepath is present we skip the
 * subprocess entirely and return the real content hash + size from the pointer metadata.
 */
async function fast_process_blob(dir: string, oid: string): Promise<{ hash: string | undefined; size: number }> {
    const [hash_proc, size_proc] = await Promise.all([
        Bun.spawn(['bash', '-c', `git cat-file blob ${oid} | sha256sum`], { cwd: dir, stdout: 'pipe', stderr: 'pipe' }),
        Bun.spawn(['git', 'cat-file', '-s', oid], { cwd: dir, stdout: 'pipe', stderr: 'pipe' }),
    ]);

    const [hashOut, sizeOut] = await Promise.all([
        new Response(hash_proc.stdout).text(),
        new Response(size_proc.stdout).text(),
        new Response(hash_proc.stderr).text(),
        new Response(size_proc.stderr).text(),
    ]);

    await Promise.all([hash_proc.exited, size_proc.exited]);

    const size = parseInt(sizeOut.trim(), 10);

    if (hash_proc.exitCode !== 0 || size_proc.exitCode !== 0 || isNaN(size)) {
        return { hash: undefined, size: isNaN(size) ? 0 : size };
    }

    const hash = hashOut.trim().split(/\s+/)[0];
    if (!hash || !/^[a-f0-9]{64}$/.test(hash)) {
        return { hash: undefined, size };
    }

    return { hash, size };
}

/**
 * Get a blobs sha256 hash and size, by trying multiple methods, ordered by speed.
 * Wants more than it needs in the best case, but is basically guaranteed to work in the worst case (but will be slower).
 */
async function get_blob_info(
    git_available: boolean,
    oid: string | undefined,
    git_directory: string,
    commit_sha: string,
    file_path: string,
    lfs_oids: Map<string, { hash: string; size: number }> | undefined,
): Promise<{ hash: string; size: number; is_lfs: boolean }> {
    let blob_hash = undefined;
    let blob_size = 0;
    if (git_available && oid != undefined) {
        // If git was available, and we were able to collect lfs ids, directly check against that
        if (lfs_oids != undefined) {
            const lfs = lfs_oids.get(file_path + ':' + commit_sha);
            if (lfs) return { ...lfs, is_lfs: true };
        }

        ({ hash: blob_hash, size: blob_size } = await fast_process_blob(git_directory, oid));
    }

    // Fallback to builtin if that didnt work
    if (blob_hash == undefined) {
        const { blob } =
            oid != undefined
                ? await readBlob({ fs, dir: git_directory, oid: oid })
                : await readBlob({ fs, dir: git_directory, oid: commit_sha, filepath: file_path });

        // LFS pointer files are always small — no point checking large blobs
        if (blob.byteLength < 512) {
            const text = new TextDecoder().decode(blob);

            if (text.startsWith('version https://git-lfs.github.com/spec/v1')) {
                const lfs_oid = text.match(/^oid sha256:([a-f0-9]{64})$/m)?.[1];
                const lfs_size = text.match(/^size (\d+)$/m)?.[1];
                if (lfs_oid && lfs_size) {
                    return { hash: lfs_oid, size: parseInt(lfs_size, 10), is_lfs: true };
                }
            }
        }
        // Probably normal file, hash the blob content directly
        blob_hash = await hash_buffer(blob);
        blob_size = blob.byteLength;
    }

    return { hash: blob_hash, size: blob_size, is_lfs: false };
}

interface PackVersion {
    actual_name: string;
    name: string;
    code: number;
    hash: string;
}

async function read_unsup_versions_from_manifest(pack_variant_name: string): Promise<{ current: PackVersion; history: PackVersion[] }> {
    if (PACKAGING == undefined) throw Error('Config not yet initialized.');

    const file = Bun.file(PACKAGING.PACKAGE_DIRECTORY + pack_variant_name + '/unsup/manifest.json');
    if (!(await file.exists())) {
        throw Error(`Unsup manifest at ${file.name} is missing.`);
    }

    const manifest_content: manifest_json = await file.json();
    function get_version_obj_from_entry(entry: { name: string; code: number }): PackVersion | undefined {
        const match = entry.name.match(/(.+?) \((\w+)\)/);
        if (match && match.length == 3 && match[1] && match[2]) {
            return {
                actual_name: entry.name,
                code: entry.code,
                name: match[1],
                hash: match[2],
            };
        } else {
            throw Error("Unsup manifest has faulty versions - format should be of 'version (short commit sha)', is: " + entry.name);
        }
    }

    const current_version = get_version_obj_from_entry(manifest_content.versions.current);
    const history_versions = manifest_content.versions.history.map(get_version_obj_from_entry);

    [current_version, ...history_versions].forEach((version) => {
        if (version == undefined) {
            throw Error("Unsup manifest has faulty versions - format should be of 'version (short commit sha)'");
        }
    });

    return {
        current: current_version as PackVersion,
        history: history_versions as PackVersion[],
    };
}

async function resolve_to_correct_git_ref(initial_ref: string): Promise<string> {
    if (PACKAGING == undefined) throw Error('Config not yet initialized.');

    const git_ref = await git_resolve_ref(RELATIVE_INSTANCE_DIRECTORY, initial_ref);
    if (git_ref != undefined) return git_ref;

    try {
        return await resolveRef({ fs: fs, dir: RELATIVE_INSTANCE_DIRECTORY, ref: initial_ref });
    } catch {
        try {
            return await expandOid({ fs: fs, dir: RELATIVE_INSTANCE_DIRECTORY, oid: initial_ref });
        } catch {
            throw Error(`ERR: Failed to resolve git ref ${initial_ref} to a valid git ref.`);
        }
    }
}

async function collect_mmc_component_versions(optional_early_instance_dir: string | undefined = undefined): Promise<Map<string, string>> {
    const component_versions = new Map();
    const instance_dir = optional_early_instance_dir ?? RELATIVE_INSTANCE_DIRECTORY;

    if (!Bun.file(instance_dir + 'mmc-pack.json').exists()) {
        console.warn('W: Missing mmc-pack.json at RELATIVE_INSTANCE_DIRECTORY (', instance_dir, '), not attaching mmc-component versions.');
        return component_versions;
    }

    const mmc_json = await Bun.file(instance_dir + 'mmc-pack.json').json();
    if (mmc_json && mmc_json.components && Array.isArray(mmc_json.components) && mmc_json.components.length > 0) {
        for (const component of mmc_json.components) {
            if (component.uid && (component.version || component.cachedVersion)) {
                component_versions.set(component.uid, component.version || component.cachedVersion);
            } else {
                console.warn('W: Component entry ', component, ' in mmc-pack.json is malformed, not including in manifest.');
            }
        }
    }

    return component_versions;
}

/**
 * This function filters an array (in form of a record) by paths (its keys)
 * @param files A record, where the key is the non-relative path (the git filepath).
 * @returns The value of the record will be returned in a list if it passes the filter.
 */
async function filter_and_plan_files<T>(
    files: Record<string, T>,
    packaging_config: PackPackagingVariant,
    mod_map?: Map<string, { mod_id: string; mod: mod_object }>,
): Promise<Array<[{ path: string; include_as: string; extra_mod_info: { mod_hash: string; direct_url: string } | undefined }, T]>> {
    if (PACKAGING == undefined) throw Error('Config not yet initialized.');

    const filtered_files: Array<
        [{ path: string; include_as: string; extra_mod_info: { mod_hash: string; direct_url: string } | undefined }, T]
    > = [];
    // Combine both filters into one, not relative, list of filters that includes what they should be included as
    const combined_filters: Array<{ filter_path: string; include_as: string | undefined; dont_track: boolean }> = [
        ...packaging_config.TRACK_INCLUDE_PATHS.map((include_filter) => {
            return {
                filter_path: include_filter.path.replace(new RegExp(`^${RELATIVE_INSTANCE_DIRECTORY}`, 'm'), ''),
                include_as: include_filter.include_as,
                dont_track: false,
            };
        }),
        ...packaging_config.FORCE_INCLUDE_PATHS.map((include_filter) => {
            return {
                filter_path: include_filter.path.replace(new RegExp(`^${RELATIVE_INSTANCE_DIRECTORY}`, 'm'), ''),
                include_as: include_filter.include_as,
                dont_track: include_filter.dont_track || false,
            };
        }),
    ];
    const exclude_filters = packaging_config.EXCLUDE_FROM_INCLUDE_PATHS.map((relative_path) =>
        relative_path.replace(new RegExp(`^${RELATIVE_INSTANCE_DIRECTORY}`, 'm'), ''),
    );
    const exclude_patterns = packaging_config.EXCLUDE_PATTERNS.map((pattern) => RegExp(pattern, 'm'));
    const non_relative_mod_dir = MOD_BASE_DIR.replace(new RegExp(`^${RELATIVE_INSTANCE_DIRECTORY}`, 'm'), '');

    file_iter: for (const [file_path, carryon_obj] of Object.entries(files)) {
        // Need to do this before we check if the jar is tracked below
        for (const filter of exclude_filters) {
            if (file_path.startsWith(filter)) {
                continue file_iter;
            }
        }

        let include_obj:
            | [{ path: string; include_as: string; extra_mod_info: { mod_hash: string; direct_url: string } | undefined }, T]
            | undefined = undefined;
        path_filter_iter: for (const path_filter of combined_filters) {
            if (!path_filter.dont_track && file_path.startsWith(path_filter.filter_path)) {
                let extra_mod_info: { hash: string; url: string } | undefined = undefined;
                if (mod_map != undefined && non_relative_mod_dir.startsWith(path_filter.filter_path) && file_path.endsWith('.jar')) {
                    // Need to relativize this here because thats how our mod jars are stored
                    let mod_file_path = file_path.startsWith(RELATIVE_INSTANCE_DIRECTORY)
                        ? file_path
                        : RELATIVE_INSTANCE_DIRECTORY + file_path;
                    const mod_obj = mod_map.get(mod_file_path)?.mod;
                    if (mod_obj == undefined) {
                        console.warn(
                            `W: Mod jar ${file_path} is in mods folder, but does not seem to be tracked by packscripts. Including by default..`,
                        );
                    } else if (mod_obj.tags != undefined && mod_obj.tags.length > 0) {
                        for (const exclude_tags of packaging_config.EXCLUDED_MOD_TAGS) {
                            for (const mod_tag of mod_obj.tags) {
                                if (mod_tag === exclude_tags) {
                                    // Mod had a tag we want to exclude, do not include it (on this filter)
                                    continue path_filter_iter;
                                }
                            }
                        }

                        let is_included = packaging_config.REQUIRED_MOD_TAGS.length == 0; // Include by default if no tags were given
                        for (const required_tag of packaging_config.REQUIRED_MOD_TAGS) {
                            for (const mod_tag of mod_obj.tags) {
                                if (mod_tag === required_tag) {
                                    is_included = true;
                                }
                            }
                        }

                        // Mod does not have any of the tags we require, do not include it (on this filter)
                        if (!is_included) continue path_filter_iter;
                    }

                    if (mod_obj != undefined && mod_obj.source && mod_obj.update_state.sha256_sum) {
                        const url_match = parse_gh_url(mod_obj.source);
                        if (url_match && url_match.primary === "releases" && url_match.secondary === "download" && url_match.key && url_match.asset) {
                            extra_mod_info = { hash: mod_obj.update_state.sha256_sum, url: mod_obj.source };
                        }
                    }
                }

                include_obj = [
                    {
                        path: file_path,
                        include_as:
                            path_filter.include_as != undefined
                                ? file_path.replace(new RegExp(`^${path_filter.filter_path}`, 'm'), path_filter.include_as)
                                : file_path,
                        extra_mod_info:
                            extra_mod_info != undefined ? { mod_hash: extra_mod_info.hash, direct_url: extra_mod_info.url } : undefined,
                    },
                    carryon_obj,
                ];
                break;
            }
        }

        if (include_obj != undefined) {
            for (const pattern of exclude_patterns) {
                if (file_path.match(pattern) != null) {
                    include_obj = undefined;
                    break;
                }
            }
        }

        if (include_obj != undefined) {
            filtered_files.push(include_obj);
        }
    }

    return filtered_files;
}

async function update_file_modmap_from_gitrefs(
    commit_hashes: string[],
    to_update_map?: Map<string, { mod_id: string; mod: mod_object }>,
): Promise<Map<string, { mod_id: string; mod: mod_object }>> {
    if (to_update_map == undefined) {
        to_update_map = new Map();
    }

    const annotated_file_path = ANNOTATED_FILE.replace(new RegExp(`^${RELATIVE_INSTANCE_DIRECTORY}`, 'm'), '');

    for (const commit_hash of commit_hashes) {
        const blob =
            (await git_read_blob_at(RELATIVE_INSTANCE_DIRECTORY, commit_hash, annotated_file_path)) ??
            (
                await readBlob({
                    fs: fs,
                    dir: RELATIVE_INSTANCE_DIRECTORY,
                    filepath: annotated_file_path,
                    oid: commit_hash,
                }).catch(() => undefined)
            )?.blob;
        if (blob == undefined) continue;

        const mod_map = await read_saved_mods(ANNOTATED_FILE, blob);

        for (const [mod_id, mod] of mod_map.entries()) {
            to_update_map.set(mod.file_path, { mod_id, mod });
        }
    }

    return to_update_map;
}

//#region initialization
export async function initialize_packaging(overwrite: boolean, skip_prompts: boolean) {
    if (PACKAGING != undefined && !(overwrite || skip_prompts)) {
        console.info('Found an already existing packaging setup, refusing to do create a new one. Overwrite with --overwrite.');
        return;
    }

    if (!skip_prompts) {
        const [PACKAGE_DIRECTORY, GIT_REMOTE_URL, GIT_LFS_REMOTE_URL, PACK_NAME] = [
            await input({
                message:
                    'PACKAGE_DIRECTORY\n Enter the directory where your packaging setup should be initialized (will be created if not present):',
                default: 'packaging',
                validate: (input: string) => {
                    if (!input.trim()) return 'ERR: Package folder path cannot be empty.';
                    return true;
                },
            }),
            await input({
                message:
                    'GIT_REMOTE_URL\n Enter a url to a raw git directory head from where the repo can be read. For github that would be "https://raw.githubusercontent.com/[USER]/[REPOSITORY]/[BRANCH]". This will be used to notify users of updates & provide some files:',
                default: 'https://raw.githubusercontent.com/[USER]/[REPOSITORY]/[BRANCH]',
                prefill: 'editable',
                validate: (input: string) => {
                    if (!input.trim()) return 'ERR: Remote manifest URL cannot be empty.';
                    return true;
                },
            }),
            await input({
                message: 'GIT_LFS_REMOTE_URL\n Enter the git lfs url for a raw view on lfs files. For github that would be :',
                default: 'https://github.com/[USER]/[REPOSITORY]/raw/[BRANCH]',
                prefill: 'editable',
            }),
            await input({
                message: 'PACK_NAME\n Enter the full name of your pack (without versions):',
                validate: (input: string) => {
                    if (!input.trim()) return 'ERR: Pack name cannot be empty.';
                    return true;
                },
            }),
        ];

        const packaging_dir = RELATIVE_INSTANCE_DIRECTORY + PACKAGE_DIRECTORY.replace(/\/$/m, '') + '/';
        const mc_dir = MOD_BASE_DIR.replace(/(?:\/)mods$/m, '') + '/';
        const packaging_config: PackagingConfig = {
            PACK_NAME: PACK_NAME,
            PACKAGE_DIRECTORY: packaging_dir,
            GIT_REMOTE_URL: GIT_REMOTE_URL.replace(/\/$/m, ''),
            GIT_LFS_REMOTE_URL: GIT_LFS_REMOTE_URL.replace(/\/$/m, ''),
            PACK_VARIANTS: {
                client: {
                    TYPE: 'client',
                    REQUIRED_MOD_TAGS: ['SIDE.CLIENT'],
                    EXCLUDED_MOD_TAGS: [],
                    TRACK_INCLUDE_PATHS: [{ path: mc_dir + 'mods' }, { path: mc_dir + 'config' }, { path: mc_dir + 'scripts' }],
                    FORCE_INCLUDE_PATHS: [
                        { path: packaging_dir + 'unsup.jar', include_as: mc_dir + 'unsup.jar.new' },
                        { path: packaging_dir + 'unsup-launcher.jar', include_as: mc_dir + 'unsup-launcher.jar', dont_track: true },
                        { path: packaging_dir + 'client/unsup.ini', include_as: mc_dir + 'unsup.ini' },
                        { path: packaging_dir + 'client/instance.cfg', include_as: 'instance.cfg', dont_track: true },
                        { path: RELATIVE_INSTANCE_DIRECTORY + 'libraries', include_as: 'libraries' },
                        { path: RELATIVE_INSTANCE_DIRECTORY + 'patches', include_as: 'patches' },
                        { path: RELATIVE_INSTANCE_DIRECTORY + 'mmc-pack.json', include_as: 'mmc-pack.json' },
                        { path: RELATIVE_INSTANCE_DIRECTORY + 'icon.png', include_as: 'icon.png' },
                    ],
                    EXCLUDE_FROM_INCLUDE_PATHS: [mc_dir + 'mods/disabled_mods'],
                    EXCLUDE_PATTERNS: ['\\.git\\w+$'],
                },
                server: {
                    TYPE: 'server',
                    REQUIRED_MOD_TAGS: ['SIDE.SERVER'],
                    EXCLUDED_MOD_TAGS: [],
                    TRACK_INCLUDE_PATHS: [
                        { path: mc_dir + 'mods', include_as: 'mods' },
                        { path: mc_dir + 'config', include_as: 'config' },
                        { path: mc_dir + 'scripts', include_as: 'scripts' },
                    ],
                    FORCE_INCLUDE_PATHS: [
                        { path: packaging_dir + 'unsup.jar', include_as: 'unsup.jar.new' },
                        { path: packaging_dir + 'unsup-launcher.jar', include_as: 'unsup-launcher.jar', dont_track: true },
                        { path: packaging_dir + 'server/unsup.ini', include_as: 'unsup.ini' },
                    ],
                    EXCLUDE_FROM_INCLUDE_PATHS: [mc_dir + 'mods/disabled_mods'],
                    EXCLUDE_PATTERNS: ['\\.git\\w+$'],
                },
            },
            MAX_WORKER_THREADS: 10,
            IMAGE: {
                GIT_CHANGE_WINDOW: 30,
                STAGING_DIRECTORY: "staging/"
            }
        };

        if (path_is_directory(packaging_dir)) {
            console.log('Deleting old packaging directory...');
            await rm(packaging_dir, { recursive: true });
        }

        // Write config back to file
        await set_config_keys({ PACKAGING: packaging_config });

        console.info(
            `\nAppended packaging config to ${CONFIG_FILE}.
        ${CLIColor.FgRed8}Please review the generated config (especially TRACK_INCLUDE_PATHS, FORCE_INCLUDE_PATHS, and EXCLUDE_PATTERNS) before continuing.${CLIColor.Reset}
        If you need to exit the setup to do that, skip back to this section by setting --skip_prompts.`,
        );

        if (
            !(await confirm({
                message: 'Accept packaging config in its current state?',
            }))
        ) {
            console.info('Cancelling...');
            return;
        }
    }

    // Have to re-read config now that it might have changed via user interaction.
    let intermediate_config = await read_intermediate_config();
    if (intermediate_config.PACKAGING == undefined) throw Error('Missing PACKAGING section on config file that should have just been added.');
    const packaging_dir = intermediate_config.PACKAGING.PACKAGE_DIRECTORY;

    // download unsup jar (which will be the same for all variants), save to newly created packaging dir
    await mkdir(packaging_dir, { recursive: true });
    console.info(
        '\nDownloading unsup & launcher jars from https://github.com/MalTeeez/unsup-fork and https://github.com/MalTeeez/unsup-launcher...',
    );
    await download_file(
        'https://github.com/MalTeeez/unsup-fork/releases/download/v1.4.1/unsup-1.2-custom+c07c4e067b.20260510.jar',
        'OTHER',
        packaging_dir.replace(/\/$/m, ''),
        'unsup.jar',
    );
    await download_file(
        'https://github.com/MalTeeez/unsup-launcher/releases/download/1.0.1/unsup-launcher-1.0.1.jar',
        'OTHER',
        packaging_dir.replace(/\/$/m, ''),
        'unsup-launcher.jar',
    );

    // Create directories for each variant, and fill them with their respective starting files
    for (const [variant_name, pack_variant] of Object.entries(intermediate_config.PACKAGING.PACK_VARIANTS)) {
        // totally not abusing recursive dir creation to skip the call to versions
        await mkdir(packaging_dir + variant_name + '/unsup/versions/', { recursive: true });

        const base_source_url =
            intermediate_config.PACKAGING.GIT_REMOTE_URL +
            '/' +
            intermediate_config.PACKAGING.PACKAGE_DIRECTORY.replace(/\/$/m, '').replace(
                new RegExp(`^${intermediate_config.RELATIVE_INSTANCE_DIRECTORY}`, 'm'),
                '',
            );

        await Bun.file(packaging_dir + variant_name + '/unsup.ini').write(
            `version=1
source_format=unsup
source=${base_source_url}/${variant_name}/unsup/manifest.json
use_parent_directory=${pack_variant.TYPE === 'client' ? 'true' : 'false'}`,
        );

        // Yes, I know this is an object but it really isn't worth to stringify here
        await Bun.file(packaging_dir + variant_name + '/unsup/manifest.json').write(
            `{
    "unsup_manifest": "root-1",
    "name": "${intermediate_config.PACKAGING.PACK_NAME} - ${variant_name.toUpperCase()}",
    "versions": {
        "current": {
            "name": "initial",
            "code": 1
        },
        "history": []
    }
}`,
        );

        if (pack_variant.TYPE === 'client') {
            await Bun.file(packaging_dir + variant_name + '/instance.cfg').write(
                `[General]
ConfigVersion=1.3
iconKey=default
name=${intermediate_config.PACKAGING.PACK_NAME}
InstanceType=OneSix
OverrideJavaArgs=true
JvmArgs="-javaagent:unsup-launcher.jar -Dunsup.debug=true -Dunsup.downloadWorkers=8 -Dunsup.versionSelectorOnLaunch=false"`,
            );
        }
    }

    console.info(
        `\nWrote initial setup to ${packaging_dir}. 
        To continue, create your first version with "packscripts package bootstrap".
        To distribute your pack, bundle your pack with "packscripts package bundle" and import it into prism / unzip & run start.sh.
        To release new versions, build them with "packscripts package build" and push the generated manifests to your git remote.`,
    );
}

//#region bootstrapping
export async function build_bootstrap(commit_sha: string, input_tag: string | undefined, target_variant?: string) {
    if (PACKAGING == undefined) {
        console.error("ERR: Missing config settings for packaging. Make sure to run 'packscripts package init' first.");
        return;
    }

    commit_sha = await resolve_to_correct_git_ref(commit_sha);
    const short_commit_sha = commit_sha.slice(0, 7);

    console.info('Walking index of git blobs...');
    const file_oids = (await git_list_tree(RELATIVE_INSTANCE_DIRECTORY, commit_sha)) ?? (await walk_tree_oids_with_isomorphic_git(commit_sha));

    console.info('Building bootstrap for git ref ', commit_sha, ' from ', file_oids.size, ' git objects...');
    const git_available = await is_git_available(RELATIVE_INSTANCE_DIRECTORY);
    const lfs_oids = git_available ? await get_lfs_oids(RELATIVE_INSTANCE_DIRECTORY, [commit_sha]) : undefined;
    const target_remote_url = PACKAGING.GIT_REMOTE_URL.replace(/[^\/]+?$/m, '') + commit_sha;
    const target_remote_lfs_url = PACKAGING.GIT_LFS_REMOTE_URL.replace(/[^\/]+?$/m, '') + commit_sha;
    const WORKER_COUNT = Math.min(PACKAGING.MAX_WORKER_THREADS, 10);

    for (const [variant_name, pack_variant] of target_variant != undefined
        ? Object.entries(PACKAGING.PACK_VARIANTS).filter((variant) => variant[0].toLowerCase() === target_variant.toLowerCase())
        : Object.entries(PACKAGING.PACK_VARIANTS)) {
        console.info(`\nRunning for pack variant '${variant_name}'`);

        // Don't mutate this across loops
        let tag = input_tag;

        const packaging_plan = await filter_and_plan_files(
            Object.fromEntries(file_oids.keys().map((path) => [path, null])),
            pack_variant,
            await update_file_modmap_from_gitrefs([commit_sha]),
        );
        const file_refs: { path: string; hash: string; size: number; url: string; mirror_url?: string }[] = [];

        console.info('Collecting git blobs...');
        const pool = create_worker_pool(packaging_plan.length, WORKER_COUNT, { live_render: true });
        pool.start();

        const queue = [...packaging_plan];
        const workers = Array.from({ length: WORKER_COUNT }, async (_, worker_id) => {
            while (queue.length > 0) {
                const plan_item = queue.shift()!;
                if (PACKAGING == undefined) throw Error('Config was initialized but is not available off-thread? Something is wrong.');

                pool.set_status(worker_id, plan_item[0].path);

                const file_oid = file_oids.get(plan_item[0].path);
                const { hash, size, is_lfs } = await get_blob_info(
                    git_available,
                    file_oid,
                    RELATIVE_INSTANCE_DIRECTORY,
                    commit_sha,
                    plan_item[0].path,
                    lfs_oids,
                );

                // Use direct git url as mirror url and direct url as primary if available
                const repo_url = (is_lfs ? target_remote_lfs_url : target_remote_url) + '/' + encodeURI(plan_item[0].path);
                const has_direct_url = plan_item[0].extra_mod_info != undefined && plan_item[0].extra_mod_info.mod_hash === hash;
                file_refs.push({
                    path: plan_item[0].include_as,
                    hash,
                    size,
                    url: has_direct_url ? plan_item[0].extra_mod_info!.direct_url : repo_url,
                    ...(has_direct_url && { mirror_url: repo_url }),
                });

                pool.complete(worker_id);
            }
        });

        await Promise.all(workers);
        pool.finish(undefined);

        const main_manifest: manifest_json = await Bun.file(PACKAGING.PACKAGE_DIRECTORY + variant_name + '/unsup/manifest.json').json();
        let version_code = main_manifest.versions.current.code + 1;

        // This might be the first run, where the version is still "initial". If that is the case, fill it with the same content that the bootstrap will get here.
        if (
            main_manifest.versions.current.name === 'initial' &&
            main_manifest.versions.current.code == 1 &&
            main_manifest.versions.history.length == 0
        ) {
            console.info('This is the initial bootstrap, also building an initial version...');
            const changes: {
                path: string;
                from_hash: string | null;
                from_size: number;
                to_hash: string | null;
                to_size: number;
                url?: string;
                mirror_url?: string;
            }[] = [];
            for (const item of file_refs) {
                changes.push({
                    path: item.path,
                    from_hash: null,
                    from_size: 0,
                    to_hash: item.hash,
                    to_size: item.size,
                    url: item.url,
                    ...(item.mirror_url != undefined && { mirror_url: item.mirror_url }),
                });
            }

            if (tag == undefined) {
                console.info(`No tag defined, using 1.0.0 for initial (${short_commit_sha}).`);
                tag = '1.0.0';
            }
            version_code = 1;

            const version_manifest: version_json = {
                unsup_manifest: 'update-1',
                hash_function: 'SHA-2 256',
                changes: changes,
                component_versions: Object.fromEntries(await collect_mmc_component_versions()),
            };
            main_manifest.versions.current = {
                name: `${tag} (${short_commit_sha})`,
                code: version_code,
            };

            await Bun.file(PACKAGING.PACKAGE_DIRECTORY + variant_name + `/unsup/versions/1.json`).write(
                JSON.stringify(version_manifest, null, 4),
            );
            await Bun.file(PACKAGING.PACKAGE_DIRECTORY + variant_name + '/unsup/manifest.json').write(JSON.stringify(main_manifest, null, 4));
        }

        const manifest_versions = await read_unsup_versions_from_manifest(variant_name);
        const all_versions = [manifest_versions.current, ...manifest_versions.history];
        const manifest_version_of_tag = all_versions.find((version) => version.name === tag);
        const manifest_version_of_commit = all_versions.find((version) => version.hash === short_commit_sha);

        if (manifest_version_of_tag != undefined) {
            // This tag exists in the manifest — does its hash match?
            if (manifest_version_of_tag.hash === short_commit_sha) {
                // Exact match on both tag and commit — reuse the existing code and tag
                version_code = manifest_version_of_tag.code;
                tag = manifest_versions.current.name;
            } else {
                // Same tag name, different commit — mark dirty
                tag = manifest_version_of_tag.name + '-dirty';
            }
        } else if (manifest_version_of_commit != undefined) {
            // Tag not found, but this commit is already recorded under a different tag — reuse its code
            version_code = manifest_version_of_commit.code;
            tag = manifest_version_of_commit.name;
        } else {
            // Neither tag nor commit found in the manifest — fall back to current + -dirty
            tag = manifest_versions.current.name + '-dirty';
        }

        console.info(`Using tag ${tag} at ${short_commit_sha} (${version_code}) for bootstrap manifest.`);
        const bootstrap_manifest: bootstrap_json = {
            unsup_manifest: 'bootstrap-1',
            version: {
                name: `${tag} (${short_commit_sha})`,
                code: version_code,
            },
            hash_function: 'SHA-2 256',
            files: file_refs,
        };

        await Bun.write(PACKAGING.PACKAGE_DIRECTORY + variant_name + '/unsup/bootstrap.json', JSON.stringify(bootstrap_manifest, null, 4));
        console.info(`Built & saved bootstrap manifest for pack variant '${variant_name}' with ${packaging_plan.length} items!`);
    }
}

//#region bundling
export async function bundle_pack_into_starter() {
    if (PACKAGING == undefined) {
        console.error("ERR: Missing config settings for packaging. Make sure to run 'packscripts package init' first.");
        return;
    }

    for (const [variant_name, pack_variant] of Object.entries(PACKAGING.PACK_VARIANTS)) {
        console.log(`Bundling files for pack variant '${variant_name}'...`);

        const files: {
            path: string;
            path_inside_zip: string;
        }[] = [];
        include_iter: for (const include_item of pack_variant.FORCE_INCLUDE_PATHS) {
            if (await Bun.file(include_item.path).exists()) {
                for (const exclude_filter of pack_variant.EXCLUDE_FROM_INCLUDE_PATHS) {
                    if (include_item.path.startsWith(exclude_filter)) {
                        continue include_iter;
                    }
                }

                files.push({
                    path: include_item.path,
                    path_inside_zip: include_item.include_as,
                });
            } else {
                if (path_is_directory(include_item.path)) {
                    glob_iter: for (const file of sync(include_item.path + '/**/*', { onlyFiles: true, deep: 10, globstar: true })) {
                        for (const exclude_filter of pack_variant.EXCLUDE_FROM_INCLUDE_PATHS) {
                            if (file.startsWith(exclude_filter)) {
                                continue glob_iter;
                            }
                        }

                        files.push({
                            path: file,
                            path_inside_zip: file.replace(include_item.path, include_item.include_as),
                        });
                    }
                } else {
                    console.warn('W: FORCE_INCLUDE_PATH item ', include_item.path, ' does not exist on disk, not including.');
                }
            }
        }

        const zip_name = `${RELATIVE_INSTANCE_DIRECTORY}${PACKAGING.PACK_NAME}-${variant_name}.zip`;
        console.info(`Writing ${files.length} files to zip (${zip_name}) for pack variant '${variant_name}'...`);
        await bundle_files_to_zip(files, zip_name);
    }
}

//#region building
export async function build_version_for_diff(
    target_commit_sha: string,
    input_base_commit_sha: string | undefined,
    tag: string | undefined,
    overwrite: boolean,
    target_variant?: string,
) {
    if (PACKAGING == undefined) {
        console.error("ERR: Missing config settings for packaging. Make sure to run 'packscripts package init' first.");
        return;
    }

    target_commit_sha = await resolve_to_correct_git_ref(target_commit_sha);
    const git_available = await is_git_available(RELATIVE_INSTANCE_DIRECTORY);
    const WORKER_COUNT = Math.min(PACKAGING.MAX_WORKER_THREADS, 4);

    for (const [variant_name, pack_variant] of target_variant != undefined
        ? Object.entries(PACKAGING.PACK_VARIANTS).filter((variant) => variant[0].toLowerCase() === target_variant.toLowerCase())
        : Object.entries(PACKAGING.PACK_VARIANTS)) {
        console.info(`\nRunning for pack variant '${variant_name}'`);

        const main_manifest: manifest_json = await Bun.file(PACKAGING.PACKAGE_DIRECTORY + variant_name + '/unsup/manifest.json').json();
        if (main_manifest.versions.current.name === 'initial') {
            console.error(
                `ERR: Tried to build version without first initializing base bootstrap. Make sure to initially create a base version with "packscripts package bootstrap".`,
            );
            return;
        }

        const versions = await read_unsup_versions_from_manifest(variant_name);

        let base_commit_sha: string | undefined = undefined;
        if (input_base_commit_sha == undefined) {
            console.info('No base commit specified, selecting from latest...');
            base_commit_sha = await resolve_to_correct_git_ref(versions.current.hash);
            console.info(`Using commit ${base_commit_sha} (${versions.current.name} - ${versions.current.code}) as base`);
        } else {
            base_commit_sha = await resolve_to_correct_git_ref(input_base_commit_sha);
        }

        if (base_commit_sha === target_commit_sha && !overwrite) {
            console.warn(
                `W: The newest available ref (${target_commit_sha}) is already available under ${versions.current.name}, refusing to build version without changes.\nIf you must, overwrite with --overwrite.`,
            );
            return;
        }

        console.info(`Building diff, with ${base_commit_sha.slice(0, 7)} as base -> and ${target_commit_sha.slice(0, 7)} as target...`);
        const lfs_oids = git_available ? await get_lfs_oids(RELATIVE_INSTANCE_DIRECTORY, [base_commit_sha, target_commit_sha]) : undefined;

        const diffs: git_tree_diff_entry[] =
            (await git_diff_tree(RELATIVE_INSTANCE_DIRECTORY, base_commit_sha, target_commit_sha)) ??
            (await diff_trees_with_isomorphic_git(base_commit_sha, target_commit_sha));

        // Filter by filepaths
        const filtered_diffs = await filter_and_plan_files(
            Object.fromEntries(diffs.map((diff_item) => [diff_item.filepath, diff_item])),
            pack_variant,
            await update_file_modmap_from_gitrefs([base_commit_sha, target_commit_sha]),
        );

        console.info(`Building list of changes from ${filtered_diffs.length} diffs...`);
        // Remove branch / git ref from remote url and use the target ref
        const target_remote_url = PACKAGING.GIT_REMOTE_URL.replace(/[^\/]+?$/m, '') + target_commit_sha;
        const target_remote_lfs_url = PACKAGING.GIT_LFS_REMOTE_URL.replace(/[^\/]+?$/m, '') + target_commit_sha;

        const changes: {
            path: string;
            from_hash: string | null;
            from_size: number;
            to_hash: string | null;
            to_size: number;
            url?: string;
        }[] = [];

        const pool = create_worker_pool(filtered_diffs.length, WORKER_COUNT);
        pool.start();

        const queue = [...filtered_diffs];
        const workers = Array.from({ length: WORKER_COUNT }, async (_, worker_id) => {
            while (queue.length > 0) {
                const [{ path: file_path, include_as: include_path, extra_mod_info }, diff_item] = queue.shift()!;
                if (PACKAGING == undefined) throw Error('Config was initialized but is not available off-thread? Something is wrong.');

                pool.set_status(worker_id, `${diff_item.status} ${file_path}`);

                if (diff_item.status === 'added') {
                    const { hash, size, is_lfs } = await get_blob_info(
                        git_available,
                        diff_item.new_oid,
                        RELATIVE_INSTANCE_DIRECTORY,
                        target_commit_sha,
                        file_path,
                        lfs_oids,
                    );

                    const repo_url = (is_lfs ? target_remote_lfs_url : target_remote_url) + '/' + encodeURI(file_path);
                    const has_direct_url = extra_mod_info != undefined && extra_mod_info.mod_hash === hash;

                    changes.push({
                        path: include_path,
                        from_hash: null,
                        from_size: 0,
                        to_hash: hash,
                        to_size: size,
                        url: has_direct_url ? extra_mod_info!.direct_url : repo_url,
                        ...(has_direct_url && { mirror_url: repo_url }),
                    });
                } else if (diff_item.status === 'deleted') {
                    const { hash, size } = await get_blob_info(
                        git_available,
                        diff_item.old_oid,
                        RELATIVE_INSTANCE_DIRECTORY,
                        base_commit_sha,
                        file_path,
                        lfs_oids,
                    );

                    changes.push({
                        path: include_path,
                        from_hash: hash,
                        from_size: size,
                        to_hash: null,
                        to_size: 0,
                    });
                } else if (diff_item.status === 'modified') {
                    const [old_blob, new_blob] = await Promise.all([
                        get_blob_info(git_available, diff_item.old_oid, RELATIVE_INSTANCE_DIRECTORY, base_commit_sha, file_path, lfs_oids),
                        get_blob_info(git_available, diff_item.new_oid, RELATIVE_INSTANCE_DIRECTORY, target_commit_sha, file_path, lfs_oids),
                    ]);

                    const repo_url = (new_blob.is_lfs ? target_remote_lfs_url : target_remote_url) + '/' + encodeURI(file_path);
                    const has_direct_url = extra_mod_info != undefined && extra_mod_info.mod_hash === new_blob.hash;

                    changes.push({
                        path: include_path,
                        from_hash: old_blob.hash,
                        from_size: old_blob.size,
                        to_hash: new_blob.hash,
                        to_size: new_blob.size,
                        url: has_direct_url ? extra_mod_info!.direct_url : repo_url,
                        ...(has_direct_url && { mirror_url: repo_url }),
                    });
                } else {
                    throw Error('Encountered an unrecognized git change while building changes from diff: ' + diff_item);
                }

                pool.complete(worker_id);
            }
        });

        await Promise.all(workers);
        pool.finish(
            `${CLIColor.Reset}Built ${CLIColor.FgWhite}${changes.length}${CLIColor.Reset} changes — ${CLIColor.FgGreen}${changes.filter((c) => c.from_hash === null).length} added${CLIColor.Reset}, ${CLIColor.FgYellow}${changes.filter((c) => c.from_hash !== null && c.to_hash !== null).length} modified${CLIColor.Reset}, ${CLIColor.FgRed}${changes.filter((c) => c.to_hash === null).length} deleted${CLIColor.Reset}.`,
        );

        const version_code = versions.current.code + 1;
        if (tag == undefined) {
            console.info('No version tag specified, incrementing patch version from latest...');
            const patch_match = versions.current.name.match(/(\d+)([^0-9]*)$/m);
            if (patch_match && patch_match[1] != undefined && !Number.isNaN(Number(patch_match[1]))) {
                const next_patch = Number(patch_match[1]) + 1;
                const suffix = patch_match[2] ?? '';
                tag = versions.current.name.replace(/(\d+)([^0-9]*)$/m, () => String(next_patch) + suffix);
            } else {
                tag = versions.current.name + '.' + version_code;
            }
            console.info(`Using tag '${tag}' for version ${version_code}.`);
        }

        const version_manifest: version_json = {
            unsup_manifest: 'update-1',
            hash_function: 'SHA-2 256',
            changes: changes,
            component_versions: Object.fromEntries(await collect_mmc_component_versions()),
        };
        main_manifest.versions.history.push(main_manifest.versions.current);
        main_manifest.versions.current = {
            name: `${tag} (${target_commit_sha.slice(0, 7)})`,
            code: version_code,
        };

        await Bun.file(PACKAGING.PACKAGE_DIRECTORY + variant_name + `/unsup/versions/${version_code}.json`).write(
            JSON.stringify(version_manifest, null, 4),
        );
        await Bun.file(PACKAGING.PACKAGE_DIRECTORY + variant_name + '/unsup/manifest.json').write(JSON.stringify(main_manifest, null, 4));
        console.info(`Built & saved manifests for pack variant '${variant_name}' under version ${tag}!`);
    }
}
