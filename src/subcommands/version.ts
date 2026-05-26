import {
    ANNOTATED_FILE,
    DOWNLOAD_TEMP_DIR,
    DOWNLOAD_UNDO_DIR,
    GITHUB_API_KEY,
    MOD_BASE_DIR,
    PACKAGING,
    RELATIVE_INSTANCE_DIRECTORY,
} from '../utils/config';
import {
    assert_gh_key,
    download_file,
    filter_assets,
    gh_request,
    print_gh_ratelimits,
    query_gh_project_by_owner_project,
    query_gh_project_by_url,
    SOURCE_API_KEYS,
} from '../utils/fetch';
import {
    collect_files_from_zip,
    extract_file_from_zip,
    glob_files_in_dir,
    is_zip_file,
    path_is_directory,
    rename_file,
    save_list_to_file,
    save_map_to_file,
} from '../utils/fs';
import {
    are_all_mods_unlocked,
    default_mod_object,
    is_mod_ignored_by_name,
    parse_mod_details,
    read_saved_mods,
    type mod_object,
    type SourceType,
} from '../utils/mods';
import {
    CLIColor,
    clone,
    finish_live_zone,
    hash_buffer,
    init_live_zone,
    is_finished,
    live_log,
    render_md,
    rev_replace_all,
    update_live_zone,
} from '../utils/utils';
import { mkdir, rename, rm } from 'node:fs/promises';
import { toNamespacedPath } from 'node:path';
import { parse_gh_url } from '../utils/sources';
import { get_dl_url_from_github_url, type Artifact } from './pr';
import {
    log_debug,
    log_err,
    log_info,
    log_ok,
    log_step,
    log_warn,
    tag_bracket,
    tag_count,
    tag_dim,
    tag_neutral,
    tag_primary,
} from '../utils/log';

interface ReleaseAsset {
    url: string;
    browser_download_url: string;
    id: number;
    name: string;
    content_type: string;
    size: number;
    digest: string | null; // sha256:2151b604e3429bff440b9fbc03eb3617bc2603cda96c95b9bb05277f9ddba255
}
interface Release {
    url: string;
    assets_url: string;
    id: number;
    tag_name: string;
    target_commitish: string;
    name: string;
    body: string;
    assets: ReleaseAsset[];
}

//#region general helpers

function color_by_age(days: number): CLIColor {
    if (days < 30) return CLIColor.FgGreen11;
    if (days < 180) return CLIColor.FgYellow1;
    if (days < 365) return CLIColor.FgOrange5;
    return CLIColor.FgRed1;
}

function render_wide_release(
    release: {
        tag_name: string;
        author: { login: string };
        name: string;
        draft: string;
        prerelease: string;
        published_at: string;
        assets: { name: string; download_count: number; size: number }[];
        body: string;
    },
    options: {
        version_padding: number;
        add_underscores?: boolean;
        text_start?: string;
        text_end?: string;
        render_assets: boolean;
        render_notes: boolean;
    },
): string {
    const age_days_raw = (new Date(Date.now()).getTime() - new Date(release.published_at).getTime()) / 86400000;
    const age_days = age_days_raw.toFixed(2);
    const padding = rev_replace_all(' '.repeat(options.version_padding - release.tag_name.length), '   ', ' . ');
    const release_name =
        release.name && release.name !== release.tag_name
            ? ` ${CLIColor.FgGray}·${CLIColor.Reset} ${CLIColor.FgWhite2}${release.name}${CLIColor.Reset}`
            : '';
    const badges =
        (release.draft ? ` ${CLIColor.BgYellow0}${CLIColor.FgBlack}${CLIColor.Bright} DRAFT ${CLIColor.Reset}` : '') +
        (release.prerelease ? ` ${CLIColor.BgMagenta0}${CLIColor.FgWhite}${CLIColor.Bright} PRE ${CLIColor.Reset}` : '');
    const author = release.author?.login
        ? `${options.add_underscores ? CLIColor.Underscore : ''}${CLIColor.FgGray} by ${CLIColor.FgGray15}${release.author.login}${CLIColor.Reset}`
        : '';
    let result_text =
        (options.text_start || `${options.add_underscores ? CLIColor.Underscore : ''}${CLIColor.FgGray} - ${CLIColor.Reset}`) +
        `${options.add_underscores ? CLIColor.Underscore : ''}${CLIColor.BgBlue0}${CLIColor.FgWhite1}${CLIColor.Bright} ${release.tag_name} ${CLIColor.Reset}` +
        `${options.add_underscores ? CLIColor.Underscore : ''}${CLIColor.FgGray}${padding}${CLIColor.Reset}` +
        `${options.add_underscores ? CLIColor.Underscore : ''}${color_by_age(age_days_raw)}${CLIColor.Bright}${age_days}${CLIColor.Reset}` +
        `${options.add_underscores ? CLIColor.Underscore : ''}${CLIColor.FgGray} days ago${CLIColor.Reset}` +
        release_name +
        badges +
        author +
        (options.text_end || '');

    result_text += '\n';

    // Assets section — colored gutter, transparent content background
    if (Array.isArray(release.assets) && release.assets.length > 0 && options.render_assets) {
        const gutter_a = `${CLIColor.BgGray5}${CLIColor.Dim}${CLIColor.FgMagenta11}▌${CLIColor.Reset}    `;
        const longest_asset = (release.assets as { name: string }[]).reduce((m, a) => Math.max(m, a.name.length), 0);
        for (const asset of release.assets as { name: string; size: number; download_count: number }[]) {
            const kb = (asset.size / 1024).toFixed(0);
            const name_pad = ' '.repeat(longest_asset - asset.name.length + 2);
            result_text +=
                gutter_a +
                `${CLIColor.FgGray} - ${CLIColor.Reset}` +
                `${CLIColor.Dim}${CLIColor.FgMagenta11}${asset.name}${CLIColor.Reset}${name_pad}` +
                `${CLIColor.FgGray10}(${CLIColor.Reset}` +
                `${CLIColor.FgGray20}${asset.download_count}↓${CLIColor.FgGray11}, ` +
                `${CLIColor.FgGray18}${kb} ${CLIColor.FgGray14}KB` +
                `${CLIColor.FgGray10})${CLIColor.Reset}\n`;
        }
        if (options.render_notes) result_text += '\n';
    }

    // Body section — colored gutter, transparent content background
    if (options.render_notes) {
        const gutter_b = `${CLIColor.BgGray3}${CLIColor.FgGray5}▌${CLIColor.Reset}    `;
        const rendered_body = render_md(release.body);
        result_text += rendered_body
            .split('\n')
            .map((line) => gutter_b + `${CLIColor.FgGray19}${line}${CLIColor.Reset}`)
            .join('\n');
        result_text += '\n';
    }

    return result_text;
}

//#region list
export async function list_all_versions_for_mod(
    mod_id: string,
    options: {
        all_pages: boolean;
        wide: boolean;
        count?: string;
        hide_assets: boolean;
        hide_notes: boolean;
    },
    mod_map?: Map<string, mod_object>,
) {
    assert_gh_key();

    let limitToXReleases = Infinity;
    if (options.count != undefined && !Number.isNaN(Number(options.count))) {
        limitToXReleases = Number(options.count);
    }

    mod_map = mod_map == undefined ? await read_saved_mods(ANNOTATED_FILE) : mod_map;

    // Resolve input mod_id to actual mod
    const lower_mod_id = mod_id.toLowerCase();
    const matched_mod_id = mod_map.keys().find((key: string) => key.toLowerCase() === lower_mod_id);
    const mod = mod_map.get(matched_mod_id || '');
    if (matched_mod_id == undefined || !mod || !mod.source) {
        console.warn('W: Failed to resolve mod id ', mod_id, ' to any source-indexed mod.');
        return;
    }

    const source_api_key = SOURCE_API_KEYS.get(mod.update_state.source_type);
    if (!source_api_key) {
        console.warn('W: Missing API key for mods source ', mod.update_state.source_type, ', ignoring.');
        return;
    }

    let { headers, status, body } = await query_gh_project_by_url(mod.source, '/releases?per_page=100');
    if (status == '200' && body != undefined && Array.isArray(body)) {
        const releases = Array.from(body);
        if (options.all_pages && headers?.get('link')?.includes('rel="last"')) {
            let page = 2;
            while (page < 10 && headers?.get('link')?.includes('rel="last"')) {
                ({ headers, status, body } = await query_gh_project_by_url(mod.source, '/releases?per_page=100&page=' + page));
                if (status == '200' && body != undefined && Array.isArray(body)) {
                    releases.push(...body);
                    page++;
                } else {
                    console.warn('W: Failed to fetch further releases for page ', page, '.');
                    break;
                }
            }
        }

        let longest_tag_length = 0;
        releases.forEach((release) => (longest_tag_length = Math.max(release.tag_name.length || 0, longest_tag_length)));
        longest_tag_length += 3;

        for (const release of releases.slice(0, Math.min(limitToXReleases, releases.length)).reverse()) {
            if (options.wide) {
                console.log(
                    render_wide_release(release, {
                        version_padding: longest_tag_length,
                        add_underscores: true,
                        text_end:
                            release.tag_name === mod.update_state.version
                                ? `   \t${CLIColor.FgGray19}<- ${CLIColor.FgGray14}[${CLIColor.FgGray19}current version${CLIColor.FgGray14}]${CLIColor.Reset}`
                                : undefined,
                        render_assets: !options.hide_assets,
                        render_notes: !options.hide_notes,
                    }),
                );
            } else {
                const age_days_raw = (new Date(Date.now()).getTime() - new Date(release.published_at).getTime()) / 86400000;
                const age_days = age_days_raw.toFixed(2);
                const padding = rev_replace_all(' '.repeat(longest_tag_length - release.tag_name.length), '   ', ' . ');
                console.log(
                    `${CLIColor.FgGray} - ${CLIColor.Reset}` +
                        `${CLIColor.FgBlue0}${CLIColor.Bright} ${release.tag_name} ${CLIColor.Reset}` +
                        `${CLIColor.FgGray}${padding}${CLIColor.Reset}` +
                        `${color_by_age(age_days_raw)}${age_days}${CLIColor.Reset}` +
                        `${CLIColor.FgGray} days ago${CLIColor.Reset}${release.tag_name === mod.update_state.version ? `   \t${CLIColor.FgGray19}<- ${CLIColor.FgGray14}[${CLIColor.FgGray19}current version${CLIColor.FgGray14}]${CLIColor.Reset}` : ''}`,
                );
            }
        }

        if (!options.all_pages && headers?.get('link')?.includes('rel="last"')) {
            console.log(
                `\n${CLIColor.FgCyan}Note${CLIColor.FgGray}: ${CLIColor.FgGray19}Older versions were truncated due to pagination. Specify ${CLIColor.Bright}${CLIColor.FgWhite}--all${CLIColor.Reset}${CLIColor.FgGray19} to include all versions.`,
            );
        }
    }

    await print_gh_ratelimits(GITHUB_API_KEY);
}

//#region switch
export async function switch_version_of_mod(
    mod_id: string,
    version: string,
    options: {
        dry: boolean;
        hide_assets: boolean;
        hide_notes: boolean;
    },
    mod_map?: Map<string, mod_object>,
) {
    assert_gh_key();
    if (!(await are_all_mods_unlocked())) {
        console.warn('W: Something is locking a file in the mods directory. Is the game still running?');
        return;
    }

    mod_map = mod_map == undefined ? await read_saved_mods(ANNOTATED_FILE) : mod_map;

    // Resolve input mod_id to actual mod
    const lower_mod_id = mod_id.toLowerCase();
    const matched_mod_id = mod_map.keys().find((key: string) => key.toLowerCase() === lower_mod_id);
    const mod = mod_map.get(matched_mod_id || '');
    if (matched_mod_id == undefined || !mod || !mod.source) {
        console.warn('W: Failed to resolve mod id ', mod_id, ' to any source-indexed mod.');
        return;
    }

    const source_api_key = SOURCE_API_KEYS.get(mod.update_state.source_type);
    if (!source_api_key) {
        console.warn('W: Missing API key for mods source ', mod.update_state.source_type, ', ignoring.');
        return;
    }

    let { headers, status, body } = await query_gh_project_by_url(mod.source, '/releases/tags/' + version, undefined, [404]);
    if (status === '200' && body != undefined && body.assets != undefined && Array.isArray(body.assets)) {
        if (options.dry) {
            // Just print the specific release for dry runs
            console.log(
                render_wide_release(body as any, {
                    version_padding: 16,
                    text_start: `  ${CLIColor.BgTeal3}${CLIColor.FgWhite1}${CLIColor.Bright} ${mod.update_state.version} ${CLIColor.Reset} ${CLIColor.Bright}${CLIColor.FgGray17}-> ${CLIColor.Reset}`,
                    render_assets: !options.hide_assets,
                    render_notes: !options.hide_notes,
                }),
            );
        } else {
            // Prepare temp directories
            await mkdir(DOWNLOAD_TEMP_DIR, { recursive: true }).catch((err) => {
                console.error(`Failed to create temporary download directory at ${toNamespacedPath(DOWNLOAD_TEMP_DIR)}`);
                throw err;
            });
            await mkdir(DOWNLOAD_UNDO_DIR, { recursive: true }).catch((err) => {
                console.error(`Failed to create temporary download directory at ${toNamespacedPath(DOWNLOAD_TEMP_DIR)}`);
                throw err;
            });

            let assets = body.assets as Array<{ browser_download_url: string; name: string; size: any }>;
            let [file_name, dl_url] = filter_assets(assets, mod.update_state.file_pattern);

            if (file_name == undefined || dl_url == undefined) {
                console.warn(
                    `W: More or less than one asset remaining for ${mod_id}: `,
                    assets.map((asset) => asset.name),
                );
                return;
            }

            // Actually download the remote version
            const res = await download_file(dl_url, mod.update_state.source_type, DOWNLOAD_TEMP_DIR, file_name, source_api_key);
            const is_base_required = mod.tags?.includes('REQUIRED_BASE') || false;

            // And replace the old file
            const old_mod_jar = mod.file_path.replace(MOD_BASE_DIR + '/', '');
            const new_mod_path = `${MOD_BASE_DIR}/${file_name + (mod.enabled ? '' : '.disabled')}`;
            await Bun.file(mod.file_path)
                .delete()
                .catch(() => {
                    console.warn('W: Failed to delete previous version of mod, at ' + old_mod_jar);
                });
            await rename(`${DOWNLOAD_TEMP_DIR}/${file_name}`, new_mod_path)
                .then(async () => {
                    console.log(
                        `Switched version of ${mod_id} from ` +
                            `${CLIColor.BgTeal3}${CLIColor.FgWhite1}${CLIColor.Bright} ${mod.update_state.version} ${CLIColor.Reset} ` +
                            `${CLIColor.FgGray}(${CLIColor.FgGray18}${old_mod_jar}${CLIColor.FgGray})${CLIColor.FgWhite3} to ` +
                            `${CLIColor.BgBlue0}${CLIColor.FgWhite1}${CLIColor.Bright} ${version} ${CLIColor.Reset} ` +
                            `${CLIColor.FgGray}(${CLIColor.FgGray18}${file_name + (mod.enabled ? '' : '.disabled')}${CLIColor.FgGray})${CLIColor.FgGray17}${CLIColor.Reset}`,
                    );

                    mod.file_path = new_mod_path;
                    mod.update_state.version = version;
                    mod.update_state.last_updated_at = new Date(Date.now()).toISOString();
                    if (is_base_required) {
                        console.info(
                            `Mod required by basegame (${mod_id}) changed in version. Don't forget to also change it externally, if required.`,
                        );
                    }
                })
                .catch(() => console.warn(`W: Failed to move switched jar ${file_name} for mod ${mod_id} into the mod directory.`));

            // Save updated files & versions back to file (only changes when upgrading)
            await save_map_to_file(ANNOTATED_FILE, mod_map);
        }
    } else if (status === '404') {
        console.log(
            `\n${CLIColor.FgRed10}Release version '${CLIColor.Bright}${version}${CLIColor.Reset}${CLIColor.FgRed10}' for ${CLIColor.Bright}${mod_id}${CLIColor.Reset}${CLIColor.FgRed10} does not exist on ${mod.update_state.source_type}.${CLIColor.Reset}`,
        );
    }

    await print_gh_ratelimits(GITHUB_API_KEY);
}

//#region restore
export async function restore_to_asset_versions(
    options: {
        dry: boolean;
    },
    mod_map?: Map<string, mod_object>,
) {
    assert_gh_key();
    if (!(await are_all_mods_unlocked())) {
        console.warn('W: Something is locking a file in the mods directory. Is the game still running?');
        return;
    }

    mod_map = mod_map == undefined ? await read_saved_mods(ANNOTATED_FILE) : mod_map;
    let to_update_mods: {
        mod_id: string;
        mod_obj: mod_object;
        file_name: string;
        file_url: string;
        source_api_key: string;
    }[] = [];
    let longest_mod_id_length = 0;

    for (const [mod_id, mod] of mod_map) {
        if (mod.source == undefined || !mod.update_state.version) continue;

        const source_api_key = SOURCE_API_KEYS.get(mod.update_state.source_type);
        if (!source_api_key) {
            console.warn('W: Missing API key for mods source ', mod.update_state.source_type, ', ignoring.');
            continue;
        }

        let { headers, status, body } = await query_gh_project_by_url(mod.source, '/releases/tags/' + mod.update_state.version, undefined, [
            404,
        ]);
        if (status === '200' && body != undefined && body.assets != undefined && Array.isArray(body.assets)) {
            let assets = body.assets as Array<{ browser_download_url: string; name: string; size: any }>;
            let [file_name, dl_url, size] = filter_assets(assets, mod.update_state.file_pattern);
            const old_mod_jar = mod.file_path.replace(RegExp(String.raw`${MOD_BASE_DIR}.*\/`), '');

            if (file_name == undefined || dl_url == undefined) {
                console.warn(
                    `W: More or less than one asset remaining for ${mod_id}: `,
                    assets.map((asset) => asset.name),
                    ', ignoring.',
                );
                continue;
            } else {
                // Only re-download the asset if the file on disk differs from the remote asset, or the file is missing
                const file = Bun.file(mod.file_path);
                if (old_mod_jar !== file_name || !(await file.exists()) || (await file.stat()).size != Number(size)) {
                    to_update_mods.push({ file_name, file_url: dl_url, mod_id, mod_obj: mod, source_api_key });
                    longest_mod_id_length = Math.max(mod_id.length, longest_mod_id_length);
                }
            }
        } else if (status === '404') {
            console.warn(
                `W: ${CLIColor.FgRed10}Release version '${CLIColor.Bright}${mod.update_state.version}${CLIColor.Reset}${CLIColor.FgRed10}' for ${CLIColor.Bright}${mod_id}${CLIColor.Reset}${CLIColor.FgRed10} does not exist on ${mod.update_state.source_type}, ignoring.${CLIColor.Reset}`,
            );
        }
    }

    // Print list of mods that would be restored
    let longest_mod_version_length = 0;
    let longest_mod_filename_length = 0;
    to_update_mods.forEach((item) => (longest_mod_id_length = Math.max(item.mod_id.length, longest_mod_id_length)));
    to_update_mods.forEach((item) => {
        longest_mod_version_length = Math.max(item.mod_obj.update_state?.version?.length || 0, longest_mod_version_length);
        longest_mod_filename_length = Math.max((item.mod_obj.file_path.split(/[\\/]/).pop() ?? '').length, longest_mod_filename_length);
    });

    console.log(`\nFound ${to_update_mods.length} mods that ${!options.dry ? 'will be' : 'can be'} restored from their remote asset:`);
    for (const item of to_update_mods) {
        const id_padding_len = longest_mod_id_length - item.mod_id.length;
        const vers_padding_len = longest_mod_version_length - (item.mod_obj.update_state.version?.length || 0);
        const filename = item.file_name;

        console.log(
            ` ${CLIColor.FgGray}-${CLIColor.Reset} ${item.mod_id} ${CLIColor.FgGray}${rev_replace_all(' '.repeat(id_padding_len), '   ', ' . ')}` +
                ` ${CLIColor.BgBlue0}${CLIColor.FgWhite1}${CLIColor.Bright} ${item.mod_obj.update_state.version} ${CLIColor.Reset}` +
                ` ${CLIColor.FgGray}${rev_replace_all(' '.repeat(vers_padding_len), '   ', ' . ')} ${CLIColor.FgGray9}(${CLIColor.FgGray19}${filename}${CLIColor.FgGray14})${CLIColor.Reset}${CLIColor.Reset}`,
        );
    }

    // If this is not a dry run and there are mods to download, actually download them
    if (to_update_mods.length > 0 && !options.dry) {
        const DOWNLOAD_BATCH_SIZE = 5;

        // Prepare temp directories
        await mkdir(DOWNLOAD_TEMP_DIR, { recursive: true }).catch((err) => {
            console.error(`Failed to create temporary download directory at ${toNamespacedPath(DOWNLOAD_TEMP_DIR)}`);
            throw err;
        });
        await mkdir(DOWNLOAD_UNDO_DIR, { recursive: true }).catch((err) => {
            console.error(`Failed to create temporary download directory at ${toNamespacedPath(DOWNLOAD_TEMP_DIR)}`);
            throw err;
        });

        let running_downloads = 0;
        let completed_downloads = 0;
        const full_dls = to_update_mods.length;
        const download_map: Map<
            string,
            { response: Promise<string>; start_time: number; file_name: string; is_base_required: boolean; mod_obj: mod_object }
        > = new Map();
        const downloaded_mods: Map<string, { file_name: string; is_base_required: boolean; mod_obj: mod_object }> = new Map();
        console.log(`\nRedownloading ${full_dls} mods...`);

        init_live_zone(2);
        while (download_map.size > 0 || to_update_mods.length > 0) {
            const progress = Math.ceil(((completed_downloads / full_dls) * 100) / 2);
            update_live_zone([
                `|${CLIColor.FgWhite}${'='.repeat(progress)}${CLIColor.FgGray}${'-'.repeat(50 - progress)}${CLIColor.Reset}|`,
                `Redownloading mods - ${CLIColor.FgWhite}${completed_downloads}${CLIColor.FgGray} of ${CLIColor.FgWhite}${full_dls}${CLIColor.Reset}`,
            ]);

            // If we have empty download slots, fill them with new downloads
            if (running_downloads < DOWNLOAD_BATCH_SIZE) {
                for (let i = 0; i < DOWNLOAD_BATCH_SIZE - running_downloads; i++) {
                    const to_download_mod = to_update_mods.pop();
                    if (to_download_mod != undefined) {
                        // console.log(`Downloading ${to_download_mod.mod_id} from ${to_download_mod.file_url}...`);
                        download_map.set(to_download_mod.mod_id, {
                            response: download_file(
                                to_download_mod.file_url,
                                to_download_mod.mod_obj.update_state.source_type,
                                DOWNLOAD_TEMP_DIR,
                                to_download_mod.file_name,
                                to_download_mod.source_api_key,
                            ),
                            start_time: Date.now(),
                            file_name: to_download_mod.file_name,
                            is_base_required: to_download_mod.mod_obj.tags?.includes('REQUIRED_BASE') || false,
                            mod_obj: to_download_mod.mod_obj,
                        });
                        running_downloads++;
                    }
                }
            }

            const finished_dls: string[] = [];
            for (const [mod_id, { response, start_time, file_name, is_base_required, mod_obj }] of download_map.entries()) {
                if (await is_finished(response)) {
                    const id_padding_len = longest_mod_id_length - mod_id.length;
                    let state_string = '?';

                    await response
                        .then((status) => (state_string = `${CLIColor.FgGreen}✔`))
                        .catch((status) => {
                            live_log(status, console.warn);
                            state_string = `${CLIColor.FgRed}✖${CLIColor.Reset}`;
                        });

                    live_log(
                        ` ${CLIColor.FgGray}-${CLIColor.Reset} ${mod_id} ${CLIColor.FgGray}${rev_replace_all(' '.repeat(id_padding_len), '   ', ' . ')}` +
                            ` ${CLIColor.Reset}${CLIColor.Bright}${state_string}${CLIColor.Reset}`,
                    );

                    downloaded_mods.set(mod_id, { file_name, is_base_required, mod_obj: mod_obj });
                    completed_downloads++;
                    running_downloads--;
                    finished_dls.push(mod_id);
                } else {
                    if (Date.now() - start_time > 20000) {
                        live_log(`W: Mod ${mod_id} has been downloading for more than 20 seconds - stalled?`, console.warn);
                    }
                }
            }
            finished_dls.forEach((mod_id) => download_map.delete(mod_id));
        }
        const progress = Math.ceil(((completed_downloads / full_dls) * 100) / 2);
        update_live_zone([
            `|${CLIColor.FgWhite}${'='.repeat(progress)}${CLIColor.FgGray}${'-'.repeat(50 - progress)}${CLIColor.Reset}|`,
            `Downloading mods${CLIColor.FgGray} - ${CLIColor.FgWhite}${completed_downloads}${CLIColor.FgGray} of ${CLIColor.FgWhite}${full_dls}${CLIColor.Reset}`,
        ]);
        finish_live_zone();

        console.log('Finished downloading all mods!\n');

        // Replace the mod jars
        if (downloaded_mods.size > 0) {
            const undo_list: Array<{ mod_id: string; old_file: string; new_file: string; old_version: string }> = [];
            // Clear old update undo jars
            (await glob_files_in_dir(DOWNLOAD_UNDO_DIR, /\.jar(?:\.disabled)?$/m, false)).forEach(
                async (file) =>
                    await Bun.file(file)
                        .delete()
                        .catch(() => console.warn('W: Failed to delete leftover undo-file for previously downloaded mod ' + file)),
            );

            for (const [mod_id, { file_name, is_base_required, mod_obj }] of downloaded_mods.entries()) {
                const mod = mod_map.get(mod_id);
                if (mod && (await Bun.file(`${DOWNLOAD_TEMP_DIR}/${file_name}`).exists())) {
                    const old_mod_jar = mod.file_path.replace(RegExp(String.raw`${MOD_BASE_DIR}.*\/`), '');
                    const new_mod_path = `${MOD_BASE_DIR}/${file_name + (mod.enabled ? '' : '.disabled')}`;

                    if (await Bun.file(`${DOWNLOAD_UNDO_DIR}/${old_mod_jar}`).exists()) {
                        await rename(mod.file_path, `${DOWNLOAD_UNDO_DIR}/${old_mod_jar}`).catch((err) => {
                            console.warn(
                                `W: Failed to move the older jar for mod ${mod_id} from the mod dir into the undo dir. Won't be able to undo the changed file for this mod.`,
                            );
                        });
                    }

                    await rename(`${DOWNLOAD_TEMP_DIR}/${file_name}`, new_mod_path)
                        .then(async () => {
                            if (!(await Bun.file(new_mod_path).exists())) {
                                console.warn(
                                    `W: Failed to move newer file for ${mod_id} (${file_name}) to mod directory. Reverting to previous version.`,
                                );
                                await rename(`${DOWNLOAD_UNDO_DIR}/${old_mod_jar}`, mod.file_path).catch((err) => {
                                    console.warn(`W: Failed to move the older jar for mod ${mod_id} back from the undo dir into the mod dir.`);
                                });
                            } else {
                                if (await Bun.file(`${DOWNLOAD_UNDO_DIR}/${old_mod_jar}`).exists()) {
                                    undo_list.push({
                                        mod_id,
                                        new_file: file_name + (mod.enabled ? '' : '.disabled'),
                                        old_file: old_mod_jar,
                                        old_version: mod.update_state?.version || '',
                                    });
                                }

                                mod.file_path = new_mod_path;
                                mod.update_state.last_updated_at = new Date(Date.now()).toISOString();
                                if (is_base_required) {
                                    console.info(
                                        `Mod required by basegame (${mod_id}) was changed. Don't forget to also change it externally, if required.`,
                                    );
                                }
                            }
                        })
                        .catch(() => console.warn(`W: Failed to move updated jar for mod ${mod_id} into the mod directory.`));
                } else if (mod != undefined) {
                    console.warn(`W: Failed to download mod for ${mod_id} for remote asset ${file_name}!`);
                }
            }
            await save_list_to_file(DOWNLOAD_UNDO_DIR + '/update_undo.json', undo_list);
        }

        // Save updated files & versions back to file (only changes when upgrading)
        await save_map_to_file(ANNOTATED_FILE, mod_map);
    }

    await print_gh_ratelimits(GITHUB_API_KEY);
}

async function fetch_gh_org_repos(org: string): Promise<{ name: string; html_url: string; full_name: string }[]> {
    const gh_api_key = SOURCE_API_KEYS.get('GITHUB');
    if (gh_api_key == undefined) throw Error('Missing github API key.');
    const repos: { name: string; html_url: string; full_name: string }[] = [];
    let page = 1;
    while (true) {
        const res = await gh_request(`/orgs/${org}/repos?per_page=100&page=${page}`, gh_api_key);
        if (!res.ok) break;
        const body = (await res.json()) as { name: string; html_url: string; full_name: string }[];
        if (!Array.isArray(body) || body.length === 0) break;
        repos.push(...body);
        if (body.length < 100) break;
        page++;
    }
    return repos;
}

//#region refresh links
export async function verify_and_refresh_source_links(
    options: {
        dry: boolean;
        orgs?: string[];
    },
    mod_map?: Map<string, mod_object>,
) {
    assert_gh_key();
    mod_map = mod_map == undefined ? await read_saved_mods(ANNOTATED_FILE) : mod_map;
    const available_repo_map: Map<string, string[]> = new Map();

    // Try to find github repos for mods that dont have any source yet in the github orgs provided in --org
    if (options.orgs && options.orgs.length > 0) {
        // Fetch each org's full repo list once, then match against it as cache
        const org_repo_lists = new Map<string, { name: string; html_url: string; full_name: string }[]>();
        for (const org of options.orgs) {
            log_step(`Fetching repo list for org ${tag_primary(org)}...`);
            org_repo_lists.set(org, await fetch_gh_org_repos(org));
        }

        for (const [mod_name, mod] of mod_map) {
            // Run only for mods that have an empty source & are on github or unknown
            if (mod.source || !(mod.update_state.source_type === 'OTHER' || mod.update_state.source_type === 'GITHUB')) continue;

            for (const org of options.orgs) {
                const repos = org_repo_lists.get(org) ?? [];

                const scored = repos
                    .map((repo) => {
                        const r = repo.name.toLowerCase().replace(/[-_]/g, '');
                        const m = mod_name.toLowerCase().replace(/[-_]/g, '');
                        const score = r === m ? 3 : r.includes(m) || m.includes(r) ? 1 : 0;
                        return { repo, score };
                    })
                    .filter((x) => x.score > 0)
                    .sort((a, b) => b.score - a.score);

                if (scored.length === 0) continue;

                log_info(
                    `Tentatively found ${scored.length} repo(s) for mod without source ${tag_primary(mod_name)}, verifying against releases...`,
                );
                available_repo_map.set(
                    mod_name,
                    scored.map((entry) => entry.repo.html_url + '/releases/tag/pleasematchmeheart'),
                );
                break;
            }
        }
    }

    for (const [mod_name, mod] of mod_map) {
        if (!mod.update_state || !mod.update_state.sha256_sum) continue;

        const source_api_key = SOURCE_API_KEYS.get(mod.update_state.source_type);
        if (!source_api_key && mod.update_state.source_type !== 'OTHER') {
            //console.warn('W: Missing API key for mods source ', mod.update_state.source_type, ', ignoring.');
            continue;
        }

        const extra_github_repos = available_repo_map.get(mod_name);
        const available_repos = extra_github_repos ?? [mod.source];
        let mod_source: string | undefined;
        let mod_source_type: SourceType;
        if (available_repos != undefined && available_repos.length > 0) {
            for (const available_repo of available_repos) {
                mod_source = extra_github_repos != undefined ? available_repo : mod.source;
                mod_source_type = extra_github_repos != undefined ? 'GITHUB' : mod.update_state.source_type;

                if (!mod_source) continue;

                switch (mod_source_type) {
                    case 'GITHUB': {
                        const url_match = parse_gh_url(mod_source);
                        if (url_match == undefined) {
                            log_warn('Encountered malformed source URL for mod ' + mod_name + ', skipping.', mod_source);
                            continue;
                        }

                        const { owner, project } = url_match;
                        // Search releases by digest to find the direct asset download URL.
                        // We don't care about the URL format — just need owner/project and the digest.
                        const digest = mod.update_state.sha256_sum;
                        function asset_matches_digest(asset: ReleaseAsset) {
                            return asset.digest != null && asset.digest.slice(7) === digest;
                        }

                        let release: Release | undefined = undefined;
                        let { headers, status, body } = await query_gh_project_by_owner_project(url_match, '/releases?per_page=100');
                        if (status == '200' && body != undefined && Array.isArray(body)) {
                            log_debug(`Found ${body.length} releases for mod ${mod_name}.`);
                            release = body.find((entry: Release) => entry.assets.find(asset_matches_digest) != undefined);

                            if (release == undefined && headers?.get('link')?.includes('rel="last"')) {
                                let page = 2;
                                while (release == undefined && page < 10 && headers?.get('link')?.includes('rel="last"')) {
                                    ({ headers, status, body } = await query_gh_project_by_url(
                                        mod_source,
                                        '/releases?per_page=100&page=' + page,
                                    ));
                                    if (status == '200' && body != undefined && Array.isArray(body)) {
                                        release = body.find((entry: Release) => entry.assets.find(asset_matches_digest) != undefined);
                                        page++;
                                    } else {
                                        log_warn('Failed to fetch further releases for page ' + page);
                                        break;
                                    }
                                }
                            }
                        }

                        if (release != undefined) {
                            log_debug(`Found matching release for ${mod_name} with version ${release.tag_name}.`);
                            const asset = release.assets.find(asset_matches_digest);
                            if (asset != undefined) {
                                mod.source = asset.browser_download_url;
                                mod.update_state.version = release.tag_name;
                                if (extra_github_repos != undefined) {
                                    mod.update_state.source_type = 'GITHUB';
                                }
                                log_info(`Found mod source ${mod_name} at github repo ${owner}/${project}, using as future source.`);
                            } else {
                                log_warn(`Found matching release for mod ${mod_name}, but failed to find matching asset.`);
                            }
                        }

                        break;
                    }
                    case 'CURSEFORGE': {
                        // TBD
                        break;
                    }
                    case 'MODRINTH': {
                        // TBD
                        break;
                    }
                    case 'OTHER': {
                        // IDK
                        break;
                    }
                    default: {
                        console.warn(`W: Encountered unkown source type '${mod.update_state.source_type}', skipping`);
                    }
                }
            }
        }
    }

    if (!options.dry) {
        await save_map_to_file(ANNOTATED_FILE, mod_map);
    }

    await print_gh_ratelimits(GITHUB_API_KEY);
}

//#region switch indev
export async function switch_to_indev_version(
    source_url: string | undefined,
    options: { dry: boolean; build_job?: string; artifact_name?: string; allow_failed_workflows?: boolean; pack_variant_name?: string },
    mod_map?: Map<string, mod_object>,
) {
    // Initial assertions
    if (source_url == undefined) {
        log_err('Missing source url.');
        return;
    }
    assert_gh_key();
    mod_map = mod_map ?? (await read_saved_mods(ANNOTATED_FILE));

    const url_match = parse_gh_url(source_url);
    const artifact = await get_dl_url_from_github_url(
        source_url,
        options.build_job,
        options.artifact_name,
        10,
        options.allow_failed_workflows ?? false,
    );
    if (artifact == undefined || url_match == undefined || url_match.primary == undefined) {
        log_err(`Failed to find a download url from source url ${tag_bracket(source_url)}.`);
        throw Error();
    } else {
        log_info(
            `Using artifact ${tag_primary(artifact.name)} ${tag_bracket(`${(artifact.size_in_bytes / 1024).toFixed(0)} KB, ${artifact.digest.slice(0, 12)}…`)}`,
        );
    }

    let { owner, project, primary, secondary, key, asset, fifth } = url_match;
    const pr_id = `${owner}/${project}/${primary}/${secondary}`;
    log_step(`Applying Artifact from ${tag_primary(pr_id)}...`);

    if (options.dry) return;

    await apply_github_artifact(artifact, options, mod_map);
}

export async function apply_github_artifact(
    artifact: Artifact,
    options: { dry: boolean; pack_variant_name?: string },
    mod_map: Map<string, mod_object>,
) {
    if (options.dry) return;

    const temp_dir = DOWNLOAD_TEMP_DIR.replace(/\/$/m, '') + '/indev';
    if (path_is_directory(temp_dir)) {
        log_info(`Old temp dir at ${tag_bracket(temp_dir)} exists, recreating..`);
        await rm(temp_dir, { recursive: true });
    }

    await mkdir(temp_dir, { recursive: true });

    // Actually download the artifact, should always be a zip or a jar (also a zip :KEKW:)
    log_step('Downloading artifact...');
    const is_zip = !artifact.name.endsWith('.jar');
    await download_file(
        artifact.archive_download_url,
        'GITHUB',
        temp_dir,
        artifact.name + (is_zip ? '.zip' : ''),
        SOURCE_API_KEYS.get('GITHUB'),
    );
    const zip_file_name = temp_dir + '/' + artifact.name + (is_zip ? '.zip' : '');
    const file = Bun.file(zip_file_name);

    // Check integrity of file
    if (!(await file.exists())) {
        log_err(`Failed to download file, is on disk missing: ${zip_file_name}`);
        return;
    } else if (file.size != artifact.size_in_bytes) {
        log_err(`Size of downloaded file differs, got ${tag_count(file.size)} against expected ${tag_count(artifact.size_in_bytes)}.`);
        return;
    } else if ((await hash_buffer(await file.bytes(), 'sha256')) !== artifact.digest) {
        log_err(
            `Checksum of file differs, got ${tag_dim(await hash_buffer(await file.bytes(), 'sha256'))} against expected ${tag_dim(artifact.digest)}.`,
        );
        return;
    } else if (!(await is_zip_file(file))) {
        log_err('Downloaded file matches expected but is not a zip / jar file. We can only handle zip / jar files for now.');
        return;
    } else {
        log_step(`Downloaded artifact ${is_zip ? 'zip' : 'jar'} ${tag_primary(artifact.name + (is_zip ? 'zip' : ''))}`);
    }

    let jar_file = artifact.name;
    let jar_file_path = zip_file_name;
    if (is_zip) {
        // Find .jar file in zip we want and extract it
        const jar_files = (await collect_files_from_zip(zip_file_name, /\.jar$/m)) ?? [];
        const filtered_jar_files = jar_files.filter((file_in_zip) => !is_mod_ignored_by_name(file_in_zip.replace(/(?:.*?)([^\/]+?$)/, '$1')));

        if (filtered_jar_files.length > 1) {
            log_err(`Zip contains more than one file after filtering. Remaining: ${filtered_jar_files.join(', ')}`);
            return;
        } else if (filtered_jar_files.length < 1) {
            log_err('Zip contains no .jar files that we want / expected.');
            return;
        }

        jar_file = (filtered_jar_files[0] as string).replace(/(?:.*?)([^\/]+?$)/, '$1');
        jar_file_path = temp_dir + '/' + jar_file;
        await Bun.write(jar_file_path, await extract_file_from_zip(zip_file_name, filtered_jar_files[0] as string));
        log_step(`Extracted mod jar from zip to ${tag_bracket(jar_file_path)}`);
    }

    // Check modid of jar for switching out with existing version
    const {
        id: mod_id,
        version: mod_version,
        wants: mod_wants,
        hash: mod_hash,
        other_mod_ids: mod_other_ids,
    } = await parse_mod_details(jar_file_path);

    // Rewrite target path based on package variant if we were given one
    let mod_dir = MOD_BASE_DIR;
    if (options.pack_variant_name != undefined) {
        if (PACKAGING == undefined) {
            throw Error('Packaging config not yet initialized, but we were given a target pack variant.');
        }
        const pack_variant = PACKAGING.PACK_VARIANTS[options.pack_variant_name];
        if (pack_variant == undefined) {
            throw Error(`Failed to find pack variant named '${options.pack_variant_name}'. Have: [${Object.keys(PACKAGING.PACK_VARIANTS)}].`);
        }

        // Taken from filter_and_plan_files() in package.ts
        const combined_filters: Array<{ filter_path: string; include_as: string | undefined }> = [
            ...pack_variant.TRACK_INCLUDE_PATHS.map((include_filter) => {
                return {
                    filter_path: include_filter.path.replace(new RegExp(`^${RELATIVE_INSTANCE_DIRECTORY}`, 'm'), ''),
                    include_as: include_filter.include_as,
                };
            }),
            ...pack_variant.FORCE_INCLUDE_PATHS.map((include_filter) => {
                return {
                    filter_path: include_filter.path.replace(new RegExp(`^${RELATIVE_INSTANCE_DIRECTORY}`, 'm'), ''),
                    include_as: include_filter.include_as,
                };
            }),
        ];
        const stripped_mod_dir = MOD_BASE_DIR.replace(new RegExp(`^${RELATIVE_INSTANCE_DIRECTORY}`, 'm'), '');
        for (const filter of combined_filters) {
            if (filter.filter_path === '') continue;
            if (stripped_mod_dir.startsWith(filter.filter_path)) {
                mod_dir =
                    RELATIVE_INSTANCE_DIRECTORY +
                    (filter.include_as != undefined
                        ? stripped_mod_dir.replace(new RegExp(`^${filter.filter_path}`, 'm'), filter.include_as)
                        : stripped_mod_dir);
                break;
            }
        }
    }

    let jar_mod_path = mod_dir + '/' + jar_file;

    // Jar could not be recognized as a mod, add it as something unknown
    if (mod_id == undefined) {
        log_warn('Failed to get an id from mod jar, directly moving to mod folder and exiting.');
        await rename_file(jar_file_path, jar_mod_path);
        return;
    }

    const mod_obj = mod_map.get(mod_id);

    // Jar was recognized as a mod, update / add it via our tracked mods
    if (mod_obj != undefined) {
        log_debug(
            `Mod ${tag_primary(mod_id)} is a tracked mod, currently under ` +
                `${tag_bracket(mod_obj.file_path)} ` +
                `with version ${tag_neutral(mod_obj.update_state.version ?? 'UNKNOWN')}.`,
        );
        const old_jar = Bun.file(mod_obj.file_path);
        if (await old_jar.exists()) {
            await old_jar.delete();
        } else {
            log_warn('Old jar is missing, skipping deletion.');
        }

        // If mod was previously disabled, also disable it here
        if (!mod_obj.enabled) {
            jar_mod_path += '.disabled';
            log_warn('Mod was previously disabled, also disabling it now.');
        }

        await rename_file(jar_file_path, jar_mod_path);
        log_step('Moved indev jar to mods folder, updating track entry...');

        mod_obj.file_path = jar_mod_path;
        mod_obj.update_state.version = mod_version ?? mod_obj.version + '-dirty';
        mod_obj.source = artifact.archive_download_url;
        mod_obj.update_state.last_updated_at = new Date(Date.now()).toISOString();
    } else {
        log_info(`Mod ${tag_primary(mod_id)} is not yet tracked, adding to map.`);

        await rename_file(jar_file_path, jar_mod_path);
        log_step('Moved indev jar to mods folder, adding track entry...');

        const new_mod_obj = clone(default_mod_object) as mod_object;
        new_mod_obj.file_path = jar_mod_path;
        new_mod_obj.enabled = true;
        new_mod_obj.update_state.version = mod_version ?? artifact.name + '-dirty';
        new_mod_obj.update_state.sha256_sum = mod_hash;
        new_mod_obj.wants = mod_wants;
        new_mod_obj.other_mod_ids = mod_other_ids || [];

        mod_map.set(mod_id, new_mod_obj);
    }

    await save_map_to_file(ANNOTATED_FILE, mod_map);

    const final_version = mod_version ?? artifact.name + '-dirty';
    log_ok(
        `Finished updating mod ${tag_primary(mod_id)} ` +
            `to indev version ${tag_neutral(final_version)} ` +
            `${tag_bracket(jar_mod_path.replace(mod_dir + '/', ''))}.`,
    );
}
