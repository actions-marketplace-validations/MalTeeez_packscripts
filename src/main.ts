//@ts-check
import { binary_search_disable } from './subcommands/binary';
import {
    enable_all_mods,
    disable_all_mods,
    type update_frequency,
    isUpdateFrequency,
    are_all_mods_unlocked,
    parse_mod_details,
} from './utils/mods';
import { annotate } from './subcommands/annotate';
import { disable_atomic_deep, enable_atomic_deep, list_mods, list_mods_folder, list_mods_wide, toggle_mod } from './subcommands/simple';
import { visualize_graph } from './subcommands/graph';
import { check_all_mods_for_updates, undo_last_update } from './subcommands/update';
import {
    list_all_versions_for_mod,
    restore_to_asset_versions,
    switch_to_indev_version,
    switch_version_of_mod,
    verify_and_refresh_source_links,
} from './subcommands/version';
import { build_bootstrap, build_version_for_diff, bundle_pack_into_starter, initialize_packaging } from './subcommands/package';
import { package_image } from './subcommands/image';
import { assert_config_exists, CI_INTEGRATION, MOD_BASE_DIR } from './utils/config';
import { init_config } from './subcommands/init';
import { apply_github_pr, pr_gate } from './subcommands/pr';
import { set_debug_enabled } from './utils/log';
import { pr_deps } from './subcommands/pr/deps';

//#region Command Framework
interface CommandDefinition {
    description: string;
    usage?: string;
    is_subcommand?: boolean;
    handler: (args: string[]) => Promise<void>;
}

const commands: Record<string, CommandDefinition> = {
    init: {
        description: 'Initialize packscripts by setting up configuration',
        handler: async () => {
            await init_config();
        },
    },
    refresh: {
        description: 'Update annotated mod list',
        usage: 'refresh [--skip_new] [--remove_nonexistent] [--remove_untagged <tag>]... [--toggle_tag <tag>]...',
        handler: async (args) => {
            const remove_untagged: string[] = [];
            const toggle_tag: string[] = [];
            for (let i = 0; i < args.length; i++) {
                if (args[i] === '--remove_untagged' && args[i + 1] != null) {
                    remove_untagged.push(args[++i] as string);
                } else if (args[i] === '--toggle_tag' && args[i + 1] != null) {
                    toggle_tag.push(args[++i] as string);
                }
            }

            await annotate({
                skip_new: args.includes('--skip_new'),
                remove_nonexistent: args.includes('--remove_nonexistent'),
                remove_untagged: remove_untagged.length > 0 ? remove_untagged : undefined,
                toggle_tag: toggle_tag.length > 0 ? toggle_tag : undefined,
            });
            console.log('Mod list refreshed successfully!');
        },
    },
    list: {
        description: 'List all indexed mods',
        usage: 'list [--files] [--enabled] [--wide]',
        handler: async (args) => {
            if (args.includes('--files')) {
                await list_mods_folder(args.includes('--enabled'));
                return;
            } else if (args.includes('--wide')) {
                await list_mods_wide(args.includes('--enabled'));
            } else {
                await list_mods();
            }
        },
    },
    binary: {
        description: 'Perform a deep-disable for a binary section',
        usage: 'binary <fraction> [fraction2...]',
        handler: async (args) => {
            if (args.length === 0) {
                console.error('Error: Missing target fraction(s), e.g. [1/4]');
                return;
            }
            await binary_search_disable(args, false);
        },
    },
    binary_dry: {
        description: 'List the mods that would be disabled with the target fraction',
        usage: 'binary_dry <fraction>',
        handler: async (args) => {
            if (args.length === 0) {
                console.error('Error: Missing target fraction, e.g. [1/4]');
                return;
            }
            await binary_search_disable(args, true);
        },
    },
    graph: {
        description: 'Build an HTML file that visualizes dependencies',
        handler: async () => {
            await visualize_graph();
        },
    },
    toggle: {
        description: 'Toggle a specific mod by its ID',
        usage: 'toggle <mod_id>',
        handler: async (args) => {
            if (args.length === 0) {
                console.error('Error: Missing mod ID to toggle');
                return;
            }
            if (!(await are_all_mods_unlocked())) {
                console.warn('W: Something is locking a file in the mods directory. Is the game still running?');
                return;
            }
            await toggle_mod(args[0]);
        },
    },
    enable_all: {
        description: 'Enable all mods',
        handler: async () => {
            await enable_all_mods();
        },
    },
    disable_all: {
        description: 'Disable all mods',
        handler: async () => {
            await disable_all_mods();
        },
    },
    enable: {
        description: 'Deep-enable specific mod(s) by ID',
        usage: 'enable <mod_id> [mod_id2...]',
        handler: async (args) => {
            if (args.length === 0) {
                console.error('Error: Missing mod ID(s) to enable');
                return;
            }
            if (!(await are_all_mods_unlocked())) {
                console.warn('W: Something is locking a file in the mods directory. Is the game still running?');
                return;
            }
            await enable_atomic_deep(args);
        },
    },
    disable: {
        description: 'Deep-disable specific mod(s) by ID',
        usage: 'disable <mod_id> [mod_id2...]',
        handler: async (args) => {
            if (args.length === 0) {
                console.error('Error: Missing mod ID(s) to disable');
                return;
            }
            if (!(await are_all_mods_unlocked())) {
                console.warn('W: Something is locking a file in the mods directory. Is the game still running?');
                return;
            }
            await disable_atomic_deep(args);
        },
    },
    update: {
        description: 'Check for mod updates down to a given frequency',
        usage: 'update <COMMON|RARE|EOL> [--retry] [--upgrade] [--downgrade]',
        handler: async (args) => {
            let frequency: update_frequency = 'COMMON';
            const freq_provided = args.length > 0 && !args[0]?.startsWith('--');
            if (freq_provided && !isUpdateFrequency(args[0])) {
                console.error('Error: Invalid frequency. Must be one of: COMMON, RARE, EOL');
                return;
            } else if (freq_provided && isUpdateFrequency(args[0])) {
                frequency = args[0];
            }
            console.log('Checking mods for updates...');
            await check_all_mods_for_updates(
                {
                    frequency_range: frequency,
                    retry_failed: args.includes('--retry'),
                    force_downgrade: args.includes('--downgrade'),
                },
                !args.includes('--upgrade'),
            );
        },
    },
    undo: {
        description: 'Undo certain previously run commands',
        usage: 'undo <UPGRADE>',
        handler: async (args) => {
            if (args.length === 0) {
                console.error('Error: Missing action to undo');
                return;
            }
            const mode = args[0]?.toLowerCase();
            if (mode != undefined) {
                if (mode.toLowerCase() === 'upgrade') {
                    await undo_last_update();
                    return;
                }
            }
            console.error('Mode', mode, 'did not match any known modes.');
        },
    },
    version: {
        description: 'Interact with remote versions of a mod',
        usage: 'version <list|set|restore_all|verify_links|switch_indev> <mod_id>',
        handler: async (args) => {
            const mode = args[0]?.toLowerCase();
            const cmd_args = args.slice(1);

            if (!mode || mode === 'help' || mode === '--help' || mode === '-h') {
                console.log(commands['version']?.usage);
                return;
            }

            const command = commands['version_' + mode];
            if (command) {
                await command.handler(cmd_args);
            } else {
                console.error(`Error: Unknown subcommand '${mode}'`);
                console.log(commands['version']?.usage);
                process.exit(1);
            }
        },
    },
    version_list: {
        description: 'List remote version of a mod',
        usage: 'version list <mod_id> [--all] [--wide] [-c=X] [--hide_assets] [--hide_notes]',
        is_subcommand: true,
        handler: async (args) => {
            if (args.includes('--help')) {
                console.log(commands['version_list']?.usage);
                return;
            }
            if (args.length == 0) {
                console.error('Error: Missing mod id');
                return;
            }

            const mod_id = args[0];
            if (mod_id != undefined) {
                const count = args.filter((arg) => arg.startsWith('-c='))[0]?.split('=', 2)[1];
                await list_all_versions_for_mod(mod_id, {
                    all_pages: args.includes('--all'),
                    wide: args.includes('--wide'),
                    count: count,
                    hide_assets: args.includes('--hide_assets'),
                    hide_notes: args.includes('--hide_notes'),
                });
                return;
            }
        },
    },
    version_set: {
        description: 'Switch an already indexed mod to a specified version, from its remote release',
        usage: 'version set <mod_id> <version> [--dry]',
        is_subcommand: true,
        handler: async (args) => {
            if (args.includes('--help')) {
                console.log(commands['version_set']?.usage);
                return;
            }
            if (args.length == 0) {
                console.error('Error: Missing mod id and version');
                return;
            } else if (args.length == 1) {
                console.error('Error: Missing remote mod version');
                return;
            }

            const mod_id = args[0];
            const mod_vers = args[1];
            if (mod_id != undefined && mod_vers != undefined) {
                await switch_version_of_mod(mod_id, mod_vers, {
                    dry: args.includes('--dry'),
                    hide_assets: args.includes('--hide_assets'),
                    hide_notes: args.includes('--hide_notes'),
                });
                return;
            }
        },
    },
    version_restore_all: {
        description:
            'Restore all mods, which can be downloaded from a remote asset, to that remote asset if it differs from the currently stored file.\n\t\t\tWill redownload if the file on disk is missing, renamed or has a different size',
        usage: 'version restore_all [--dry]',
        is_subcommand: true,
        handler: async (args) => {
            if (args.includes('--help')) {
                console.log(commands['version_restore_all']?.usage);
                return;
            }

            await restore_to_asset_versions({ dry: args.includes('--dry') });
            return;
        },
    },
    version_verify_links: {
        description: 'Verify all mods source links against their version and update it if the local version is newer.',
        usage: 'version verify_links [--dry]',
        is_subcommand: true,
        handler: async (args) => {
            if (args.includes('--help')) {
                console.log(commands['version_verify_links']?.usage);
                return;
            }
            await verify_and_refresh_source_links({ dry: args.includes('--dry') });
            return;
        },
    },
    version_switch_indev: {
        description: 'Switch a mod to an in-development build fetched from a GitHub Actions artifact',
        usage: 'version switch_indev <source_url> [--dry] [--build_job <job name>] [--artifact_name <part of artifact name>] [--allow_failed_workflows]',
        is_subcommand: true,
        handler: async (args) => {
            if (args.includes('--help')) {
                console.log(commands['version_switch_indev']);
                return;
            }

            let build_job: string | undefined;
            let artifact_name: string | undefined;
            const positional: string[] = [];
            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                if (arg === '--build_job' && args[i + 1] != undefined) {
                    build_job = args[i + 1];
                } else if (arg === '--artifact_name' && args[i + 1] != undefined) {
                    artifact_name = args[i + 1];
                } else if (arg != null && !arg.startsWith('-')) {
                    positional.push(arg);
                }
            }

            await switch_to_indev_version(positional[0], {
                dry: args.includes('--dry'),
                build_job,
                artifact_name,
                allow_failed_workflows: args.includes('--allow_failed_workflows'),
            });
            return;
        },
    },
    package: {
        description: 'Package your modpack into prism zips & provide them with updates via unsup',
        usage: 'package <init|build|bundle|bootstrap|image>',
        handler: async (args) => {
            const mode = args[0]?.toLowerCase();
            const cmd_args = args.slice(1);

            if (!mode || mode === 'help' || mode === '--help' || mode === '-h') {
                console.log(commands['package']?.usage);
                return;
            }

            const command = commands['package_' + mode];
            if (command) {
                await command.handler(cmd_args);
            } else {
                console.error(`Error: Unknown subcommand '${mode}'`);
                console.log(commands['package']?.usage);
                process.exit(1);
            }
        },
    },
    package_init: {
        description: 'Setup packaging for a modpack via config settings and a few starter files.',
        usage: 'package init [--overwrite] [--skip_prompts]',
        is_subcommand: true,
        handler: async (args) => {
            if (args.includes('--help') || args.includes('-h')) {
                console.log(commands['package_init']?.usage);
                return;
            }
            await initialize_packaging(args.includes('--overwrite'), args.includes('--skip_prompts'));
            return;
        },
    },
    package_bootstrap: {
        description: 'Build the bootstrap for the provided commit sha (assumes HEAD if none is provided) (Will override the old bootstrap manifest).',
        usage: 'package bootstrap [<git ref>] [-t|--tag tag] [--variant variant]',
        is_subcommand: true,
        handler: async (args) => {
            if (args.includes('--help') || args.includes('-h')) {
                console.log(commands['package_bootstrap']?.usage);
                return;
            }

            let tag: string | undefined;
            let variant: string | undefined;
            const positional: string[] = [];
            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                if (arg === '-t' || arg === '--tag') {
                    tag = args[++i];
                } else if (arg === '--variant') {
                    variant = args[++i];
                } else if (arg != null && !arg.startsWith('-')) {
                    positional.push(arg);
                }
            }

            await build_bootstrap(positional.at(-1) ?? 'HEAD', tag, variant);

            return;
        },
    },
    package_build: {
        description:
            'Build the changes since a specified commit (assumes the latest version if none is provided) and the provided target git ref (or HEAD if none is provided) into a version manifest that will propagate the update. Accepts a version in the form of -t <version>.',
        usage: 'package build <target git ref> <base git ref> [-t tag] [--overwrite]',
        is_subcommand: true,
        handler: async (args) => {
            if (args.includes('--help') || args.includes('-h')) {
                console.log(commands['package_build']?.usage);
                return;
            }

            // Collect positional args (non-flag values, excluding -t and its value)
            const positional: string[] = [];
            let tag: string | undefined;
            let variant: string | undefined;
            for (let i = 0; i < args.length; i++) {
                if (args[i] === '-t') {
                    tag = args[++i];
                } else if (args[i] === '--variant') {
                    variant = args[++i];
                } else if (!args[i]?.startsWith('-')) {
                    positional.push(args[i] as string);
                }
            }

            const base_ref = positional[1];
            const target_ref = positional[0] ?? 'HEAD';

            await build_version_for_diff(target_ref, base_ref, tag, args.includes('--overwrite'), variant);

            return;
        },
    },
    package_bundle: {
        description: 'Bundle the current pack into a zip.',
        usage: 'package bundle',
        is_subcommand: true,
        handler: async (args) => {
            if (args.includes('--help') || args.includes('-h')) {
                console.log(commands['package_bundle']?.usage);
                return;
            }

            await bundle_pack_into_starter();

            return;
        },
    },
    package_image: {
        description: 'Build a Docker layer plan from mod change frequency and populate a staging directory.',
        usage: 'package image <target_dockerfile> <mods path in image> [--include_tag <tag>]... [--exclude_tag <tag>]... [--dry]',
        is_subcommand: true,
        handler: async (args) => {
            if (args.includes('--help') || args.includes('-h')) {
                console.log(commands['package_image']?.usage);
                return;
            }

            const include_tags: string[] = [];
            const exclude_tags: string[] = [];
            let size_multiplier: number | undefined = undefined;
            let freq_multiplier: number | undefined = undefined;
            const positional: string[] = [];
            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                if (arg === '--include_tag' && args[i + 1] != undefined) {
                    include_tags.push(args[i + 1] as string);
                } else if (arg === '--exclude_tag' && args[i + 1] != undefined) {
                    exclude_tags.push(args[i + 1] as string);
                } else if (arg === '--mult_size' && args[i + 1] != undefined && !Number.isNaN(args[i + 1])) {
                    size_multiplier = Number(args[i + 1]);
                } else if (arg === '--mult_freq' && args[i + 1] != undefined && !Number.isNaN(args[i + 1])) {
                    freq_multiplier = Number(args[i + 1]);
                } else if (arg != undefined && !arg.startsWith('-')) {
                    positional.push(arg);
                }
            }

            await package_image(positional[0], positional[1], {
                dry: args.includes('--dry'),
                exclude_tags: exclude_tags.length == 0 ? undefined : exclude_tags,
                include_tags: include_tags.length == 0 ? undefined : include_tags,
                size_multiplier: size_multiplier,
                frequency_multiplier: freq_multiplier,
            });
            return;
        },
    },
    pr: {
        description: 'Apply or validate PR dependency chains',
        usage: 'pr <apply|gate|deps>',
        handler: async (args) => {
            const mode = args[0]?.toLowerCase();
            const cmd_args = args.slice(1);

            if (!mode || mode === 'help' || mode === '--help' || mode === '-h') {
                console.log(commands['pr']?.usage);
                return;
            }

            const command = commands['pr_' + mode];
            if (command) {
                await command.handler(cmd_args);
            } else {
                console.error(`Error: Unknown subcommand '${mode}'`);
                console.log(commands['pr']?.usage);
                process.exit(1);
            }
        },
    },
    pr_apply: {
        description: 'Fetch and apply a mod build artifact from a GitHub PR, recursively resolving cross-repo deps and merged-since-daily PRs',
        usage: 'pr apply <pr_url> [--dry] [--build_job <name>]... [--artifact_name <part>] [--allow_failed_workflows] [--allow_external_owners] [--other_allowed_owner <owner>]... [--wait_timeout <seconds>] [--poll_interval <seconds>] [--debug]',
        is_subcommand: true,
        handler: async (args) => {
            if (args.includes('--help') || args.includes('-h')) {
                console.log(commands['pr_apply']?.usage);
                return;
            }

            // Parse value-flags first, then collect positionals.
            let artifact_name: string | undefined;
            let wait_timeout_seconds: number | undefined;
            let poll_interval_seconds: number | undefined;
            const build_jobs: string[] = [];
            const other_allowed_owners: string[] = [];
            const positional: string[] = [];
            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                if (arg === '--build_job' && args[i + 1] != undefined) {
                    build_jobs.push(args[++i] as string);
                } else if (arg === '--artifact_name' && args[i + 1] != undefined) {
                    artifact_name = args[++i];
                } else if (arg === '--other_allowed_owner' && args[i + 1] != undefined) {
                    other_allowed_owners.push(args[++i] as string);
                } else if (arg === '--wait_timeout' && args[i + 1] != undefined) {
                    wait_timeout_seconds = Number(args[++i]);
                } else if (arg === '--poll_interval' && args[i + 1] != undefined) {
                    poll_interval_seconds = Number(args[++i]);
                } else if (arg != null && !arg.startsWith('-')) {
                    positional.push(arg);
                }
            }

            // Wait + poll intervals fall back to CI_INTEGRATION config when no flag was passed.
            const wait_timeout_ms = (wait_timeout_seconds ?? CI_INTEGRATION?.WAIT_TIMEOUT_SECONDS ?? 0) * 1000;
            const poll_interval_ms = (poll_interval_seconds ?? CI_INTEGRATION?.POLL_INTERVAL_SECONDS ?? 30) * 1000;

            await apply_github_pr(positional[0], {
                dry: args.includes('--dry'),
                build_jobs: build_jobs.length > 0 ? build_jobs : undefined,
                artifact_name,
                allow_failed_workflows: args.includes('--allow_failed_workflows'),
                allow_external_owners: args.includes('--allow_external_owners'),
                other_allowed_owners: other_allowed_owners.length > 0 ? other_allowed_owners : undefined,
                wait_timeout_ms,
                poll_interval_ms,
            });
            return;
        },
    },
    pr_gate: {
        description: 'Validate every cross-repo dep of the given PR is merged with a published release; exit 0 = mergeable',
        usage: 'pr gate <pr_url> [--allow_external_owners] [--other_allowed_owner <owner>]... [--build_job <name>]... [--debug]',
        is_subcommand: true,
        handler: async (args) => {
            if (args.includes('--help') || args.includes('-h')) {
                console.log(commands['pr_gate']?.usage);
                return;
            }

            const build_jobs: string[] = [];
            const other_allowed_owners: string[] = [];
            const positional: string[] = [];
            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                if (arg === '--build_job' && args[i + 1] != undefined) {
                    build_jobs.push(args[++i] as string);
                } else if (arg === '--other_allowed_owner' && args[i + 1] != undefined) {
                    other_allowed_owners.push(args[++i] as string);
                } else if (arg != null && !arg.startsWith('-')) {
                    positional.push(arg);
                }
            }

            await pr_gate(positional[0], {
                build_jobs: build_jobs.length > 0 ? build_jobs : undefined,
                allow_external_owners: args.includes('--allow_external_owners'),
                other_allowed_owners: other_allowed_owners.length > 0 ? other_allowed_owners : undefined,
            });
            return;
        },
    },
    pr_deps: {
        description: 'Download direct dependencies of a PR and build a JSON metadata manifest',
        usage: 'pr deps <pr_url> --target_dir <dir> --jar_suffix <suffix> [--dry] [--build_job <name>]... [--allow_external_owners] [--other_allowed_owner <owner>]... [--debug]',
        is_subcommand: true,
        handler: async (args) => {
            if (args.includes('--help') || args.includes('-h')) {
                console.log(commands['pr_deps']?.usage);
                return;
            }

            let target_dir: string | undefined;
            let jar_suffix: string | undefined;
            const build_jobs: string[] = [];
            const other_allowed_owners: string[] = [];
            const positional: string[] = [];

            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                if (arg === '--target_dir' && args[i + 1] != undefined) {
                    target_dir = args[++i];
                } else if (arg === '--jar_suffix' && args[i + 1] != undefined) {
                    jar_suffix = args[++i];
                } else if (arg === '--build_job' && args[i + 1] != undefined) {
                    build_jobs.push(args[++i] as string);
                } else if (arg === '--other_allowed_owner' && args[i + 1] != undefined) {
                    other_allowed_owners.push(args[++i] as string);
                } else if (arg != null && !arg.startsWith('-')) {
                    positional.push(arg);
                }
            }

            if (!target_dir) {
                console.error('Error: Missing required flag --target_dir');
                console.log(commands['pr_deps']?.usage);
                process.exit(1);
            }

            if (!jar_suffix) {
                console.error('Error: Missing required flag --jar_suffix');
                console.log(commands['pr_deps']?.usage);
                process.exit(1);
            }

            await pr_deps(positional[0], {
                target_dir,
                jar_suffix,
                dry: args.includes('--dry'),
                build_jobs: build_jobs.length > 0 ? build_jobs : undefined,
                allow_external_owners: args.includes('--allow_external_owners'),
                other_allowed_owners: other_allowed_owners.length > 0 ? other_allowed_owners : undefined,
            });
            return;
        },
    },
    debug: {
        description: 'Run debug operations',
        handler: async (args) => {
            console.log(await parse_mod_details(MOD_BASE_DIR + "/" + "gregtech-5.09.52.526-git.1+dcb1a7eb3c-dirty.jar"))
        },
    },
};

function showHelp() {
    console.log('Usage: packscripts <command> [arguments]\n');
    console.log('Available commands:\n');

    const max_cmd_length = Math.max(...Object.keys(commands).map((k) => k.length));

    for (const [cmd, def] of Object.entries(commands)) {
        const clean_cmd = def.is_subcommand ? cmd.replace('_', ' ') : cmd;
        const cmd_padded = clean_cmd.padEnd(max_cmd_length + 2);
        const usage = def.usage || clean_cmd;
        console.log(`  ${cmd_padded}${def.description}`);
        if (def.usage) {
            console.log(`  ${''.padEnd(max_cmd_length + 2)}Usage: ${usage}`);
        }
        console.log();
    }
}

//#region Entrypoint
async function main() {
    const args = process.argv.slice(2);
    const mode = args[0]?.toLowerCase();
    const cmd_args = args.slice(1);

    // Global --debug flag - flips the debug gate in utils/log so log_debug calls become visible.
    if (args.includes('--debug')) set_debug_enabled(true);

    if (!mode || mode === 'help' || mode === '--help' || mode === '-h') {
        showHelp();
        return;
    }

    if (mode !== 'init') {
        assert_config_exists();
    }

    const command = commands[mode];
    if (command) {
        await command.handler(cmd_args);
    } else {
        console.error(`Error: Unknown command '${mode}'`);
        showHelp();
        process.exit(1);
    }
}

// Forward to main function with arguments
if (import.meta.url === import.meta.resolve('file://' + process.argv[1])) {
    main().catch(console.error);
} else {
    main().catch(console.error);
}
