import { ANNOTATED_FILE, MOD_BASE_DIR } from './config';
import {
    extract_file_from_zip,
    extract_text_from_zip,
    hash_file,
    is_folder_locked,
    read_from_file,
    rename_file,
    save_map_to_file,
    scan_mods_folder,
    search_zip_for_string,
} from './fs';
import { dedup_array, type JsonObject } from './utils';

//#region types
export enum UpdateFrequenciesEnum {
    COMMON = 'COMMON',
    RARE = 'RARE',
    EOL = 'EOL',
}
export type update_frequency = keyof typeof UpdateFrequenciesEnum;
export type SourceType = 'GITHUB' | 'CURSEFORGE' | 'MODRINTH' | 'OTHER';

export interface update_state {
    version: string | undefined;
    disable_check: boolean;
    frequency: update_frequency;
    source_type: SourceType;
    last_status: string;
    last_updated_at: string | undefined;
    file_pattern: string | undefined;
    sha256_sum: string;
    // We only need this, so that we can access the attributes via [string]
    [key: string]: string | boolean | undefined;
}

export interface mod_object {
    file_path: string;
    tags: string[] | undefined;
    source: string | undefined;
    notes: string | undefined;
    wanted_by: string[] | undefined;
    wants: string[] | undefined;
    enabled: boolean | undefined;
    other_mod_ids: string[] | undefined;
    update_state: update_state;
    // We only need this, so that we can access the attributes via [string]
    [key: string]: string | string[] | boolean | undefined | update_state;
}

export const default_mod_object: mod_object = {
    file_path: '',
    tags: ['SIDE.CLIENT', 'SIDE.SERVER'],
    source: '',
    notes: '',
    wanted_by: [],
    wants: [],
    enabled: true,
    other_mod_ids: [],
    update_state: {
        version: '',
        disable_check: false,
        frequency: 'EOL',
        last_status: '200',
        last_updated_at: '',
        source_type: 'OTHER',
        file_pattern: '',
        sha256_sum: '',
    },
};

export interface update_state_unsafe {
    version?: string | undefined;
    last_updated_at?: string | undefined;
    sha256_sum: string;
    // We only need this, so that we can access the attributes via [string]
    [key: string]: string | boolean | undefined;
}

export interface mod_object_unsafe {
    mod_id: string;
    file_path: string;
    enabled: boolean;
    wants?: string[];
    other_mod_ids?: string[];
    update_state: update_state_unsafe;
    // We only need this, so that we can access the attributes via [string]
    [key: string]: string | JsonObject | string[] | boolean | undefined | update_state_unsafe;
}

/**
 * Checks if safe conversion from properties of mod_object_unsafe to properties of mod_object can be done.
 * Feel free to assert type with `as string | string[] | boolean` afterwards.
 */
export function isModPropertySafe(prop: string | JsonObject | string[] | boolean | undefined | update_state): boolean {
    return (
        typeof prop === 'string' ||
        (Array.isArray(prop) && (prop.length == 0 || prop.filter((entry) => typeof entry === 'string').length == prop.length)) ||
        (typeof prop === 'object' && Object.values(prop).filter((sub_prop) => !isModPropertySafe(sub_prop)).length == 0)
    );
}

export function isUpdateFrequency(val: any): val is update_frequency {
    return Object.values(UpdateFrequenciesEnum).includes(val as UpdateFrequenciesEnum);
}

export function getUpdateFrequencyOrdinal(freq: update_frequency): number {
    return Object.values(UpdateFrequenciesEnum).indexOf(freq as UpdateFrequenciesEnum);
}

//#region general
/**
 * Read a map of annotated mods from a json file, and return them as parsed objects
 * @param annotated_file The file path to the json file
 * @returns A map, keyed by the mod id
 */
export async function read_saved_mods(annotated_file: string, blob?: Uint8Array<ArrayBufferLike>): Promise<Map<string, mod_object>> {
    const file_contents = blob != undefined ? JSON.parse(new TextDecoder().decode(blob)) : await read_from_file(annotated_file);
    const file_map: Map<string, mod_object> = new Map(Object.entries(file_contents)) as Map<string, mod_object>;

    const mod_map = new Map<string, mod_object>();
    for (const [mod_id, mod] of file_map) {
        const modObj: mod_object = {
            file_path: mod.file_path,
            tags: mod.tags || default_mod_object.tags,
            source: mod.source || default_mod_object.source,
            notes: mod.notes || default_mod_object.notes,
            wanted_by: mod.wanted_by || default_mod_object.wanted_by,
            wants: mod.wants || default_mod_object.wants,
            enabled: mod.enabled !== undefined ? mod.enabled : default_mod_object.enabled,
            other_mod_ids: mod.other_mod_ids || default_mod_object.other_mod_ids,
            update_state: {
                version: mod.update_state?.version || default_mod_object.update_state.version,
                disable_check: mod.update_state?.disable_check || default_mod_object.update_state.disable_check,
                frequency:
                    mod.update_state?.frequency != undefined
                        ? mod.update_state?.frequency
                        : ((mod.source as string) || ('' as string)).startsWith('https://github.com')
                          ? 'COMMON'
                          : default_mod_object.update_state.frequency,
                last_status: mod.update_state?.last_status || default_mod_object.update_state.last_status,
                last_updated_at: mod.update_state?.last_updated_at || default_mod_object.update_state.last_updated_at,
                source_type: mod.update_state?.source_type || mod.source ? get_source_type_from_url(mod.source) : default_mod_object.update_state.source_type,
                file_pattern: mod.update_state?.file_pattern || default_mod_object.update_state.file_pattern,
                sha256_sum: mod.update_state.sha256_sum || '',
            },
        };
        mod_map.set(mod_id, modObj);
    }

    return mod_map;
}

function get_source_type_from_url(url: string | undefined): 'GITHUB' | 'CURSEFORGE' | 'MODRINTH' | 'OTHER' {
    if (url == undefined) return 'OTHER';
    if (url.startsWith('https://github.com') || url.startsWith('https://api.github.com')) {
        return 'GITHUB';
    } else if (url.startsWith('https://modrinth.com')) {
        return 'MODRINTH';
    } else if (url.startsWith('https://www.curseforge.com')) {
        return 'CURSEFORGE';
    }
    return 'OTHER';
}

/**
 * Enable mods with the REQUIRED_BASE flag, as a way to keep mods enabled.
 * This function should be called after broad actions that disable mods.
 * This function does not handle saving mod_map to file,
 * so the outer calling function must save afterwards.
 */
export async function enable_base_mods(mod_map: Map<string, mod_object>) {
    const changed_list: string[] = [];

    // Get base required mods from tag
    for (const [mod_id, mod_object] of mod_map) {
        if (mod_object.tags && mod_object.tags.includes('REQUIRED_BASE') && !mod_object.enabled) {
            console.log('Re-Enabling mod required by basegame:', mod_id);
            await enable_mod_deep(mod_id, mod_map, changed_list);
        }
    }
}

/**
 * Disable a mod, with its dependents
 * @param mod_id The mod to disable
 * @param mod_map A mod map, from read_saved_mods()
 * @param changed_list A list of mod ids, to keep track of which mods we have already updated
 * @returns The number of mods that were changed
 */
export async function toggle_mod_deep(mod_id: string, mod_map: Map<string, mod_object>, changed_list: Array<string>): Promise<number> {
    let change_count = 0;

    const mod = mod_map.get(mod_id);
    if (mod != undefined) {
        if (mod.enabled) {
            // Disable self
            change_count += await disable_mod_deep(mod_id, mod_map, changed_list);
        } else {
            // Enable self
            change_count += await enable_mod_deep(mod_id, mod_map, changed_list);
        }
    }

    return change_count;
}

/**
 * Disable a mod, with its dependents
 * @param mod_id The mod to disable
 * @param mod_map A mod map, from read_saved_mods()
 * @param changed_list A list of mod ids, to keep track of which mods we have already updated
 * @returns The number of mods that were changed
 */
export async function disable_mod_deep(
    mod_id: string,
    mod_map: Map<string, mod_object>,
    changed_list: Array<string>,
    ancestor_chain: Array<string> = [],
): Promise<number> {
    let change_count = 0;

    // Cycle detection via an ancester chain that contains the id of the all deps we've visited before.
    // Will be empty for the top level of each chain because we only pass a new array with spread downwards
    if (ancestor_chain.includes(mod_id)) {
        console.warn(`W: Dependency cycle detected, please fix your deps for these mods: 
            ${[...ancestor_chain, mod_id].join(' -> ')}`);
        return 0;
    }

    const mod = mod_map.get(mod_id);
    if (mod != undefined) {
        // Disable dependents
        if (mod.wanted_by && mod.wanted_by.length > 0) {
            const next_chain = [...ancestor_chain, mod_id];
            for (const dependency of mod.wanted_by) {
                if (isNotItself(dependency, mod_id, mod.other_mod_ids || [])) {
                    change_count += await disable_mod_deep(dependency, mod_map, changed_list, next_chain);
                }
            }
        }
        // Make sure we didnt already touch this mod before & its enabled
        if (!changed_list.includes(mod_id) && mod.enabled) {
            console.log('Disabling mod ', mod_id);
            // Mod was enabled before (as is the name now), add .disabled suffix
            const new_path = mod.file_path + '.disabled';
            await rename_file(mod.file_path, new_path);
            mod.file_path = new_path;

            mod.enabled = false;
            changed_list.push(mod_id);
            change_count++;
        }
    }

    return change_count;
}

export function isNotItself(base: string, mod_id: string, other_mod_ids: string[]): boolean {
    return base.toLowerCase() != mod_id.toLowerCase() && other_mod_ids.find((other_id) => other_id.toLowerCase() === mod_id.toLowerCase()) == undefined;
}

/**
 * Disable a mod, with its dependents
 * @param mod_id The mod to disable
 * @param mod_map A mod map, from read_saved_mods()
 * @param changed_list A list of mod ids, to keep track of which mods we have already updated
 * @param ancestor_chain A list of mod id deps we have already visited, not be set by the top level
 * @returns The number of mods that were changed
 */
export async function enable_mod_deep(
    mod_id: string,
    mod_map: Map<string, mod_object>,
    changed_list: Array<string>,
    ancestor_chain: Array<string> = [],
): Promise<number> {
    let change_count = 0;

    // Cycle detection via an ancester chain that contains the id of the all deps we've visited before.
    // Will be empty for the top level of each chain because we only pass a new array with spread downwards
    if (ancestor_chain.includes(mod_id)) {
        console.warn(`W: Dependency cycle detected, please fix your deps for these mods: 
            ${[...ancestor_chain, mod_id].join(' -> ')}`);
        return 0;
    }

    const mod = mod_map.get(mod_id);
    if (mod != undefined) {
        // Enable dependencies
        if (mod.wants && mod.wants.length > 0) {
            const next_chain = [...ancestor_chain, mod_id];
            for (const dependency of mod.wants) {
                // console.log(`Enabling dependency of ${mod_id}: ${dependency}`)
                change_count += await enable_mod_deep(dependency, mod_map, changed_list, next_chain);
            }
        }
        // Make sure we didnt already touch this mod before & its disabled
        if (!changed_list.includes(mod_id) && !mod.enabled) {
            console.log('Enabling mod ', mod_id);
            // Mod was disabled before (as is the name now), remove .disabled suffix
            const new_path = mod.file_path.replace(/\.disabled$/m, '');
            await rename_file(mod.file_path, new_path);
            mod.file_path = new_path;

            mod.enabled = true;
            changed_list.push(mod_id);
            change_count++;
        }
    }

    return change_count;
}

export async function enable_all_mods(mod_map?: Map<string, mod_object>) {
    if (!(await are_all_mods_unlocked())) {
        console.warn('W: Something is locking a file in the mods directory. Is the game still running?');
        return;
    }

    // Initialize map if not provided, since we can't use await in param
    mod_map = mod_map == undefined ? await read_saved_mods(ANNOTATED_FILE) : mod_map;
    const change_list: string[] = [];
    let changes = 0;

    for (const [mod_id, mod_object] of mod_map) {
        changes += await enable_mod_deep(mod_id, mod_map, change_list);
    }

    if (changes > 0) {
        await save_map_to_file(ANNOTATED_FILE, mod_map);
        console.log('Changed ', changes, ' mods.\n');
    } else {
        console.log('No changes made.');
    }
}

export async function disable_all_mods(mod_map?: Map<string, mod_object>) {
    if (!(await are_all_mods_unlocked())) {
        console.warn('W: Something is locking a file in the mods directory. Is the game still running?');
        return;
    }

    // Initialize map if not provided, since we can't use await in param
    mod_map = mod_map == undefined ? await read_saved_mods(ANNOTATED_FILE) : mod_map;
    const change_list: string[] = [];
    let changes = 0;

    for (const [mod_id, mod_object] of mod_map) {
        changes += await disable_mod_deep(mod_id, mod_map, change_list);
    }
    await enable_base_mods(mod_map);

    if (changes > 0) {
        await save_map_to_file(ANNOTATED_FILE, mod_map);
        console.log('Changed ', changes, ' mods.\n');
    } else {
        console.log('No changes made.');
    }
}

export function parse_mod_filename(file_path: string) {
    let s = file_path
        .replace(/^.*\//, '') // strip path
        .replace(/\.jar(?:\.disabled)?$/, '') // strip extension
        .replace(/^(?:\[[A-Za-z\d]+\]|[-+\d.])+/, '') // strip leading [TAG], +, -, digits
        .replace(/\[[^\]]*\]/g, ''); // strip all [bracket] groups

    // Split on MC version — everything before is name+modver, after is noise
    const mc_match = /[-+_ .]*(?:mc)?1\.7\.10[-+_ .]*/gi.exec(s);
    const before_mc = mc_match ? s.slice(0, mc_match.index) : s;
    const after_mc = mc_match ? s.slice(mc_match.index + mc_match[0].length) : '';

    // A version-start token: digit, v/V+digit, or git hash (7+ hex chars)
    const VERSION_TOKEN = /^(v?\d|[0-9a-f]{7,}\b)/i;

    // Tokenize before_mc and find first separator+token that looks like a version
    const parts = before_mc.split(/([-+_. ]+)/);
    let name = parts[0];
    let version = '';

    for (let i = 1; i < parts.length; i += 2) {
        const tok = parts[i + 1] || '';
        if (VERSION_TOKEN.test(tok)) {
            version = parts.slice(i + 1).join('');
            break;
        }
        name += parts[i] + tok;
    }

    // No version before MC? Look after it (e.g. BetterFoliage-MC1.7.10-2.0.17)
    if (!version && after_mc) {
        const after_parts = after_mc.split(/([-+_. ]+)/);
        let found = false;
        for (let i = 0; i < after_parts.length; i += 2) {
            if (!found && after_parts[i] != undefined && VERSION_TOKEN.test(after_parts[i]!)) found = true;
            if (found) version += (after_parts[i - 1] ?? '') + after_parts[i];
        }
    }

    // Still nothing? Check for alpha-style version in after_mc: V33a, V33b
    if (!version && after_mc) {
        const m = after_mc.match(/^[Vv]\d+\w*/);
        if (m) version = m[0];
    }

    // Special case: version was entirely in [brackets] that got stripped
    // Try to recover it from the original string
    if (!version) {
        const bracketed = file_path.match(/\[v?([\d][^\]]+)\]/i);
        if (bracketed && bracketed[1] != undefined) version = bracketed[1]!;
    }

    return {
        id: name?.replace(/[-+_. ]+$/, '').trim() || undefined,
        version: version.replace(/^[-+_. ]+|[-+_. ]+$/g, '') || undefined,
    };
}

/**
 * Extract more infos about a list of mods from their contained mcmod.info files (json)
 * @param files A map of mod jars, of type <file path, file basename>, usually returned by scan_mods_folder()
 */
export async function extract_modinfos(files: Map<string, string>): Promise<Map<string, mod_object_unsafe>> {
    const mods = new Map();
    const file_paths = Array.from(files.keys());
    const POOL_SIZE = 8;

    for (let i = 0; i < file_paths.length; i += POOL_SIZE) {
        const batch = file_paths.slice(i, i + POOL_SIZE);
        const results = await Promise.all(batch.map(async (file_path) => ({ file_path, ...(await parse_mod_details(file_path)) })));
        for (const { file_path, id, other_mod_ids, state, version, wants, hash } of results) {
            if (id != undefined) {
                const mod: mod_object_unsafe = {
                    mod_id: id,
                    other_mod_ids: other_mod_ids,
                    wants: wants,
                    enabled: state,
                    file_path: file_path,
                    update_state: {
                        version: version,
                        sha256_sum: hash,
                    },
                };
                mods.set(file_path, mod);
            } else {
                console.warn('W: Failed to parse mod id for file', file_path, ', ignoring.');
            }
        }
    }
    return mods;
}

/**
 * Parse the mcmod.info inside a mod file, to get its infos
 * @param info_json Contents of the mods mcmod.info file, might be a json object, a string or undefined
 * @param basename The basename of the file, with extension
 */
export async function parse_mod_details(file_path: string): Promise<{
    id: string | undefined;
    other_mod_ids: string[] | undefined;
    wants: Array<string>;
    version: string | undefined;
    state: boolean;
    hash: string;
}> {
    let mod_id: undefined | string = undefined;
    let other_mod_ids: string[] | undefined = undefined;
    let wants: Array<string> = [];
    let mod_version: undefined | string;
    const mod_state: boolean = !file_path.endsWith('.disabled');

    const hash = hash_file(file_path, 'sha256');
    const filename_match = parse_mod_filename(file_path) 

    const info_json: JsonObject | JsonObject[] | string | undefined = await extract_text_from_zip(file_path, 'mcmod.info')
        .then((file_data: string) => {
            // Try to parse the modinfo file as json
            try {
                return JSON.parse(file_data);
            } catch (err) {
                // console.error('Failed to parse mod info for file ', file_path, ' with err ', err);
                if (file_data.length > 0) {
                    return file_data;
                }
                return undefined;
            }
        })
        .catch(() => {
            return undefined;
        });

    // Get all infos from mcmod.info
    if (typeof info_json === 'object') {
        if (Array.isArray(info_json) && info_json[0]) {
            // Mod-ID
            if (info_json[0].modid && typeof info_json[0].modid === 'string' && info_json[0].modid.length > 0) {
                // if (info_json.length > 1) {
                //     console.log("Multiple Mod-Ids for ", file_path)
                //     for (const entry of info_json) {
                //         console.log(": ", entry.modid)
                //     }
                // }
                mod_id = info_json[0].modid;
                // Sometimes the mcmod.info file has multiple entries for a single mod, ususually submodules
                // Some mods reference not the main mod (usually the first entry), but one of these submodules
                if (info_json.length > 1) {
                    other_mod_ids = info_json
                        .slice(1)
                        .filter((mod_entry) => mod_entry.modid && typeof mod_entry.modid === 'string')
                        .map((mod_entry) => mod_entry.modid) as string[];
                }
            }
            // Mod-Wants
            if (info_json[0].requiredMods && Array.isArray(info_json[0].requiredMods) && info_json[0].requiredMods.length > 0) {
                wants = info_json[0].requiredMods as unknown as string[];
            } else if (info_json[0].dependencies && Array.isArray(info_json[0].dependencies) && info_json[0].dependencies.length > 0) {
                wants = info_json[0].dependencies as unknown as string[];
            }
            if (info_json.length > 1) {
                wants.push(
                    ...[
                        ...(info_json
                            .slice(1)
                            .filter((mod_entry) => mod_entry.dependencies && Array.isArray(mod_entry.dependencies))
                            .flatMap((mod_entry) => mod_entry.dependencies) as string[]),
                        ...(info_json
                            .slice(1)
                            .filter((mod_entry) => mod_entry.requiredMods && Array.isArray(mod_entry.requiredMods))
                            .flatMap((mod_entry) => mod_entry.requiredMods) as string[]),
                    ],
                );
            }
            // Mod-Version
            if (info_json[0].version && typeof info_json[0].version === 'string') {
                mod_version = info_json[0].version;
            }
        } else if (!Array.isArray(info_json) && info_json.modList && Array.isArray(info_json.modList) && info_json.modList[0]) {
            // Mod-ID
            if (info_json.modList[0].modid && typeof info_json.modList[0].modid === 'string' && info_json.modList[0].modid.length > 0) {
                mod_id = info_json.modList[0].modid;

                // Sometimes the mcmod.info file has multiple entries for a single mod, ususually submodules
                // Some mods reference not the main mod (usually the first entry), but one of these submodules
                if (info_json.modList.length > 1) {
                    other_mod_ids = info_json.modList
                        .slice(1)
                        .filter((mod_entry) => mod_entry.modid && typeof mod_entry.modid === 'string')
                        .map((mod_entry) => mod_entry.modid) as string[];
                }
            }
            // Mod-Wants
            if (info_json.modList[0].requiredMods && Array.isArray(info_json.modList[0].requiredMods) && info_json.modList[0].requiredMods.length > 0) {
                wants = info_json.modList[0].requiredMods as unknown as string[];
            } else if (info_json.modList[0].dependencies && Array.isArray(info_json.modList[0].dependencies) && info_json.modList[0].dependencies.length > 0) {
                wants = info_json.modList[0].dependencies as unknown as string[];
            }
            if (info_json.modList.length > 1) {
                wants.push(
                    ...[
                        ...(info_json.modList
                            .slice(1)
                            .filter((mod_entry) => mod_entry.dependencies && Array.isArray(mod_entry.dependencies))
                            .flatMap((mod_entry) => mod_entry.dependencies) as string[]),
                        ...(info_json.modList
                            .slice(1)
                            .filter((mod_entry) => mod_entry.requiredMods && Array.isArray(mod_entry.requiredMods))
                            .flatMap((mod_entry) => mod_entry.requiredMods) as string[]),
                    ],
                );
            }

            // Mod-Version
            if (info_json.modList[0].version && typeof info_json.modList[0].version === 'string') {
                mod_version = info_json.modList[0].version;
            }
        } else {
            // console.log('thing seems to be malformed');
        }
    } else {
        // console.log('thing seems to be very malformed', typeof info_json);
    }

    // If the json was existent, but had empty values (was malformed), the mod id might still be undefined
    if (typeof info_json === 'string' && mod_id == undefined) {
        // Couldn't parse the file as json, try it as a simple key for the id
        const modid_matches = info_json.matchAll(/"modid":\s*"(.*?)"/g).toArray();
        if (modid_matches && modid_matches.length > 0) {
            if (modid_matches[0] !== undefined) {
                const match = modid_matches[0].at(1);
                if (match && match !== '') {
                    mod_id = match;
                }
            }
            // Even here, we can have multiple submodules, since just a single mistake can throw off the json parsing
            if (modid_matches.length > 1) {
                other_mod_ids = modid_matches
                    .slice(1)
                    .filter((match) => typeof match.at(1) === 'string' && match.at(1) !== '')
                    .map((match) => match.at(1)) as string[];
            }
        }
        // Info json was just missing, so we fall back further
    } else if (info_json === undefined || mod_id == undefined) {
        // mod_id is still not found, so we try to extract it from its file name
            if (filename_match.id) {
                //console.info("\t ^^ Found id secondary through regex")
                mod_id = filename_match.id;
            }
    }

    // Get all info from the @Mod annotation inside the mods main class
    const { main_deps, main_version } = await get_details_from_mainclass(file_path);

    // Mod-Version fallbacks & filtering
    if (mod_version && !mod_version.match(/(\d)/) && mod_version.toLowerCase().includes('version')) {
        // Version does not have a single number, and contains "version itself" - probably malformed
        mod_version = undefined;
    }
    if (mod_version == undefined && main_version) {
        mod_version = main_version;
    } else if (mod_version == undefined && filename_match.version) {
        mod_version = filename_match.version;
    }
    // Remove 1.7.10 from version if something reasonable remains
    if (mod_version !== undefined) {
        const possible_version = mod_version.replace(/[-+.]*(?:mc)?(?:1\.7\.10|1710)[-+.]*/i, '');
        if (possible_version.length < mod_version.length && possible_version.length > 1 && possible_version.match(/(\d)/)) {
            mod_version = possible_version;
        } else if (possible_version.length == 0 && filename_match.version) {
            mod_version = filename_match.version;
        }
    }

    // Expand wants with the ones from the @Mod annotation, filter and deduplicate
    if (mod_id) {
        wants = filter_for_faulty_dependencies([...wants, ...main_deps], mod_id, other_mod_ids || []);
    } else {
        console.warn(`W: Failed to get any mod id for ${file_path}, faulty file?`);
        wants = [];
    }

    return { id: mod_id, other_mod_ids: other_mod_ids, wants: wants, version: mod_version, state: mod_state, hash: await hash };
}

/**
 * Extract the dependencies of a mod (by its id and file path) from a "@Mod" annotation encoded somewhere in the bytecode of the mainclass of the mod
 * @returns A list of dependencies this mod has
 */
export async function get_details_from_mainclass(file_path: string): Promise<{ main_deps: string[]; main_version?: string }> {
    const deps: Set<string> = new Set();
    let version: string | undefined = undefined;

    const mod_annotation_pattern = new RegExp(/\u0019Lcpw\/mods\/fml\/common\/Mod;((?:.|(?:\r\n|\n|\x0b|\f|\r|\x85)){1,512})/);
    // Mod Annotation terminators (not very reliable): (?:\u0001\u0000(?:\u0023|\u0011|(?:\u0005bytes)))/);
    const dep_version_pattern = new RegExp(/(?:\u0007|\u000c|\u000a)version\u0001\u0000(?:[\u0003-\u000c])(.+?)\u0001\u0000/);
    const dep_entry_pattern = new RegExp(
        /required-after:(?<mod_id>(?<first_char>[a-zA-Z])(?:[a-zA-Z]|\d{1}|[\+\-\|](?:(?!mc|MC)[a-zA-Z]{2}|[aI]))+?)(?:[ \n\r;@\u0001]|$)/gm,
    );
    const search_result = await search_zip_for_string(file_path, 'Lcpw/mods/fml/common/Mod;');
    if (search_result != undefined) {
        for (const [main_file, data] of search_result) {
            // Get annotation statement
            const match = data.match(mod_annotation_pattern)?.at(1);
            if (match != undefined) {
                // Get dependency tags
                for (const dep_match of match.matchAll(dep_entry_pattern)) {
                    const dep_id = dep_match.at(1);
                    if (dep_id) {
                        deps.add(dep_id);
                    }
                }
                // Get version tag
                const version_match = match.match(dep_version_pattern)?.at(1);
                if (version_match != undefined) {
                    version = version_match;
                }
            } else {
                // console.log(`W: Failed get @Mod annotation for main: ${main_file}`)
            }
        }
    } else {
        // We failed to find the mainclass and its annotation in the mod, which probably means its injected via ASM
    }

    return { main_deps: Array.from(deps), main_version: version };
}

export function filter_for_faulty_dependencies(wants: string[], mod_id: string, other_mod_ids: string[]): string[] {
    // Filter on the depdencies of a mod
    //  Some mods enter their deps not as a json array, but as a string with commas
    let old_wants = Array.from(wants);
    wants = [];
    for (let dep of old_wants) {
        dep = dep.replace(/@.+$/, '');
        if (dep.includes(',')) {
            wants.push(...dep.split(','));
        } else {
            wants.push(dep);
        }
    }
    old_wants = Array.from(wants);
    wants = [];
    for (let dep of old_wants) {
        //  Filter out references to forge
        if (dep.match(/((?:Minecraft)?Forge(?:@|$))|(^\s*FML\s*$)/im)) {
            continue;
            // And to the main mod module (from submodules)
        } else if (dep.toLowerCase() === mod_id?.toLowerCase()) {
            continue;
            // And to itself
        } else if (other_mod_ids.find((other_id) => other_id.toLowerCase() === dep.toLowerCase()) != undefined) {
            continue;
        } else {
            dep = dep.replace(/^required-after:/m, '');
        }
        wants.push(dep.trim());
    }
    //  Filter out duplicates case-inse
    wants = dedup_array(wants);

    return wants;
}

export async function are_all_mods_unlocked(): Promise<boolean> {
    return !(await is_folder_locked(MOD_BASE_DIR));
}

export function is_mod_ignored_by_name(file_name: string): boolean {
    if (file_name.endsWith('.jar')) {
        if (
            !file_name.endsWith('-sources.jar') &&
            !file_name.endsWith('-dev.jar') &&
            !file_name.endsWith('-api.jar') &&
            !file_name.endsWith('-preshadow.jar') &&
            !file_name.endsWith('-prestub.jar') &&
            !file_name.endsWith('-javadoc.jar') &&
            !file_name.endsWith('-reobf.jar') &&
            !file_name.includes('-panama-') &&
            !file_name.includes('-deploader')
        ) {
            return false;
        }
    }
    return true;
}
