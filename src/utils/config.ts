import path from 'node:path';
import { existsSync } from 'node:fs';

export const IS_LIMITED_ENV = (Bun.env.PACKSCRIPTS_IS_LIMITED_ENV || '0') === '1';
export const CONFIG_FILE = 'packscripts.json';
export const ENV_FILE = '.packscripts.env.json';

// Walk up the directory tree from CWD to find the config file, then chdir to
// that directory so all relative paths in the config resolve correctly regardless
// of whether packscripts is invoked from inside the submodule or from the root.
function find_and_chdir_to_config(filename: string): void {
    let dir = process.cwd();
    while (true) {
        if (existsSync(path.join(dir, filename))) {
            process.chdir(dir);
            return;
        }
        const parent = path.dirname(dir);
        if (parent === dir) return; // probably filesystem root — no config found, stay in CWD
        dir = parent;
    }
}

export interface PackagingConfig {
    PACK_NAME: string;
    PACKAGE_DIRECTORY: string;
    GIT_REMOTE_URL: string;
    GIT_LFS_REMOTE_URL: string;
    PACK_VARIANTS: {
        [key: string]: PackPackagingVariant;
    };
    MAX_WORKER_THREADS: number;
    IMAGE?: {
        GIT_CHANGE_WINDOW?: number;
        STAGING_DIRECTORY?: string;
    };
}

export interface PackPackagingVariant {
    TYPE: 'server' | 'client';
    REQUIRED_MOD_TAGS: Array<string>;
    EXCLUDED_MOD_TAGS: Array<string>;
    TRACK_INCLUDE_PATHS: Array<{
        path: string;
        include_as?: string;
    }>;
    FORCE_INCLUDE_PATHS: Array<{
        path: string;
        include_as: string;
        dont_track?: boolean;
    }>;
    EXCLUDE_FROM_INCLUDE_PATHS: Array<string>;
    EXCLUDE_PATTERNS: Array<string>;
}

export interface SourceOverride {
    default_branch?: string;
    daily_version_override?: string;
}

export interface CIIntegrationConfig {
    WAIT_TIMEOUT_SECONDS?: number;
    POLL_INTERVAL_SECONDS?: number;
    SOURCE_OVERRIDES?: Record<string, SourceOverride>;
}

export interface Config {
    MOD_BASE_DIR: string;
    DOWNLOAD_TEMP_DIR: string;
    DOWNLOAD_UNDO_DIR: string;
    ANNOTATED_FILE: string;
    RELATIVE_INSTANCE_DIRECTORY: string;
    PACKAGING?: PackagingConfig | undefined;
    CI_INTEGRATION?: CIIntegrationConfig | undefined;
}

let config_file_exists: boolean;
let config: Config;

const _workdir = Bun.env.PACKSCRIPTS_WORKDIR;
if (_workdir) process.chdir(_workdir);

const _config_env = Bun.env.PACKSCRIPTS_CONFIG;
if (_config_env) {
    config_file_exists = true;
    if (_config_env.startsWith('http://') || _config_env.startsWith('https://')) {
        const _resp = await fetch(_config_env);
        if (!_resp.ok) throw new Error(`Failed to fetch packscripts config from ${_config_env}: ${_resp.status} ${_resp.statusText}`);
        config = (await _resp.json()) as Config;
    } else {
        const _abs = path.resolve(_config_env);
        config = await Bun.file(_abs).json();
        process.chdir(path.dirname(_abs));
    }
} else {
    // Default: walk up to find packscripts.json and chdir to its directory.
    find_and_chdir_to_config(CONFIG_FILE);
    config_file_exists = await Bun.file(CONFIG_FILE).exists();
    config = config_file_exists ? await Bun.file(CONFIG_FILE).json() : ({} as Config);
}

export function assert_config_exists(): void {
    if (!config_file_exists) throw Error("Missing config file. Make sure to first initialize your pack with 'packscripts init'.");
}

let secrets = (await Bun.file(ENV_FILE).exists()) ? await Bun.file(ENV_FILE).json() : undefined;

export const RELATIVE_INSTANCE_DIRECTORY: string = (config?.RELATIVE_INSTANCE_DIRECTORY?.replace(/\/?$/m, '') ?? '.') + '/';
export const MOD_BASE_DIR: string = config?.MOD_BASE_DIR?.replace(/\/$/m, '');
export const DOWNLOAD_TEMP_DIR: string =
    (config?.DOWNLOAD_TEMP_DIR?.replace(/\/$/m, '') as string | undefined) ?? RELATIVE_INSTANCE_DIRECTORY + '.packscripts_tmp/downloads/';
export const DOWNLOAD_UNDO_DIR: string =
    (config?.DOWNLOAD_UNDO_DIR?.replace(/\/$/m, '') as string | undefined) ?? RELATIVE_INSTANCE_DIRECTORY + '.packscripts_tmp/undos/';

// PACKSCRIPTS_ANNOTATED overrides the annotated mods file location (URL or local path).
// If a URL is given, the file is downloaded to CWD/<filename> so it remains writable.
let annotated_override: string | undefined;
const _annotated_env = Bun.env.PACKSCRIPTS_ANNOTATED;
if (_annotated_env) {
    if (_annotated_env.startsWith('http://') || _annotated_env.startsWith('https://')) {
        const _url_obj = new URL(_annotated_env);
        const _filename = path.basename(_url_obj.pathname) || 'annotated.json';
        const _dest = path.join(process.cwd(), _filename);
        const _resp = await fetch(_annotated_env);
        if (!_resp.ok) throw new Error(`Failed to fetch annotated file from ${_annotated_env}: ${_resp.status} ${_resp.statusText}`);
        await Bun.write(_dest, await _resp.arrayBuffer());
        annotated_override = _dest;
    } else {
        annotated_override = path.resolve(_annotated_env);
    }
}

export const ANNOTATED_FILE: string = (annotated_override ?? config?.ANNOTATED_FILE)?.replace(/\/$/m, '');
export const PACKAGING = config?.PACKAGING;
export const CI_INTEGRATION = config?.CI_INTEGRATION;
export const GITHUB_API_KEY: string | undefined = secrets?.GITHUB_API_KEY || Bun.env.PACKSCRIPTS_GITHUB_API_KEY || undefined;

type ConfigKey = keyof NonNullable<typeof config>;

export async function read_intermediate_config(): Promise<Config> {
    if (!(await Bun.file(CONFIG_FILE).exists())) throw Error('Config file at ' + CONFIG_FILE + ' is missing, but we require it here.');
    return await Bun.file(CONFIG_FILE).json();
}

async function write_config() {
    await Bun.write(CONFIG_FILE, JSON.stringify(config, null, 4));
}

export async function set_config_key<K extends ConfigKey>(key: K, value: NonNullable<typeof config>[K]) {
    if (!config) config = {} as NonNullable<typeof config>;
    config[key] = value;
    await write_config();
}

export async function set_config_keys(entries: Partial<NonNullable<typeof config>>) {
    if (!config) config = {} as NonNullable<typeof config>;
    Object.assign(config, entries);
    await write_config();
}
