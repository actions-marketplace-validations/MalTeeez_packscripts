# packscripts

## for
### usage
First: Track your modpack with Git if you haven't done so yet. Even without packscripts, this will save you pain.

To Start:
Download your preferred binary from github releases & move it into your modpack root directory.

Packscripts (in its current form) is a CLI tool - that means you interact with it through the commandline, be it bash, powershell or whatever. NOT via a GUI (Graphical User Interface) but a CLI (Command Line Interface).
If you haven't worked with the commandline before, this is a good point to start: https://www.phys.uconn.edu/~rozman/Courses/P2200_23F/downloads/introduction_to_cli.pdf

To initialize packscripts for your modpack:
In the working directory of your modpack (where packscripts is now also located), run:
`packscripts init` and answer its questions.
Afterwards, run `packscripts refresh` to initialize your modlist.

### development
To install dependencies:

```bash
bun install
```

To run:

```bash
bun main
```

## commands
Available commands:
```
Usage: packscripts <command> [arguments]

Available commands:

  init                  Initialize packscripts by setting up configuration
  refresh               Update annotated mod list
                        Usage: refresh [--skip_new] [--remove_nonexistent] [--remove_untagged <tag>]... [--toggle_tag <tag>]...
  list                  List all indexed mods
                        Usage: list [--files] [--enabled] [--wide]
  binary                Perform a deep-disable for a binary section
                        Usage: binary <fraction> [fraction2...]
  binary_dry            List the mods that would be disabled with the target fraction
                        Usage: binary_dry <fraction>
  graph                 Build an HTML file that visualizes dependencies
  toggle                Toggle a specific mod by its ID
                        Usage: toggle <mod_id>
  enable_all            Enable all mods
  disable_all           Disable all mods
  enable                Deep-enable specific mod(s) by ID
                        Usage: enable <mod_id> [mod_id2...]
  disable               Deep-disable specific mod(s) by ID
                        Usage: disable <mod_id> [mod_id2...]
  update                Check for mod updates down to a given frequency
                        Usage: update <COMMON|RARE|EOL> [--retry] [--upgrade] [--downgrade]
  undo                  Undo certain previously run commands
                        Usage: undo <UPGRADE>
  version               Interact with remote versions of a mod
                        Usage: version <list|set|restore_all|verify_links|switch_indev> <mod_id>
  version list          List remote version of a mod
                        Usage: version list <mod_id> [--all] [--wide] [-c=X] [--hide_assets] [--hide_notes]
  version set           Switch an already indexed mod to a specified version, from its remote release
                        Usage: version set <mod_id> <version> [--dry]
  version restore_all   Restore all mods, which can be downloaded from a remote asset, to that remote asset if it differs from the currently stored file.
                        Will redownload if the file on disk is missing, renamed or has a different size
                        Usage: version restore_all [--dry]
  version verify_links  Verify all mods source links against their version and update it if the local version is newer.
                        Usage: version verify_links [--dry] [--org <github_org>]...
  version switch_indev  Switch a mod to an in-development build fetched from a GitHub Actions artifact
                        Usage: version switch_indev <source_url> [--dry] [--build_job <job name>] [--artifact_name <part of artifact name>] [--allow_failed_workflows]
  package               Package your modpack into prism zips & provide them with updates via unsup
                        Usage: package <init|build|bundle|bootstrap|image>
  package init          Setup packaging for a modpack via config settings and a few starter files.
                        Usage: package init [--overwrite] [--skip_prompts]
  package bootstrap     Build the bootstrap for the provided commit sha (assumes HEAD if none is provided) (Will override the old bootstrap manifest).
                        Usage: package bootstrap [<git ref>] [-t|--tag tag] [--variant variant]
  package build         Build the changes since a specified commit (assumes the latest version if none is provided) and the provided target git ref (or HEAD if none is provided) into a version manifest that will propagate the update. Accepts a version in the form of -t <version>.
                        Usage: package build <target git ref> <base git ref> [-t tag] [--overwrite]
  package bundle        Bundle the current pack into a zip.
                        Usage: package bundle
  package image         Build a Docker layer plan from mod change frequency and populate a staging directory.
                        Usage: package image <target_dockerfile> <mods path in image> [--include_tag <tag>]... [--exclude_tag <tag>]... [--dry]
  pr                    Apply or validate PR dependency chains
                        Usage: pr <apply|gate|deps>
  pr apply              Fetch and apply a mod build artifact from a GitHub PR, recursively resolving cross-repo deps and merged-since-daily PRs
                        Usage: pr apply <pr_url> [--dry] [--build_job <name>]... [--artifact_name <part>]... [--allow_failed_workflows] [--allow_external_owners] [--other_allowed_owner <owner>]... [--wait_timeout <seconds>] [--poll_interval <seconds>] [--debug]
  pr gate               Validate every cross-repo dep of the given PR is merged with a published release; exit 0 = mergeable. Pass --allow_all_merged to also accept merged-but-unreleased deps.
                        Usage: pr gate <pr_url> [--allow_external_owners] [--other_allowed_owner <owner>]... [--build_job <name>]... [--allow_all_merged] [--debug]
  pr deps               Download direct dependencies of a PR and build a JSON metadata manifest
                        Usage: pr deps <pr_url> --target_dir <dir> --jar_suffix <suffix> [--dry] [--build_job <name>]... [--artifact_name <part>]... [--allow_external_owners] [--other_allowed_owner <owner>]... [--debug]
```

## GitHub Action

We also ship a composite GitHub Action (via `action.yml`) that makes it easy to run packscripts commands in CI without having to manage the binary yourself. It automatically downloads the correct binary for the runner OS and architecture, then executes the requested command.

**This is mainly intended for:** automating PR gating, scheduled update checks, packaging builds, and any other packscripts workflow you want to run in GitHub Actions. If you do not always need packscripts in an image (i.e. your modpack), do NOT include it. The resulting binaries are a bit too big for that.

### Inputs

| Input | Required | Description |
|---|---|---|
| `command` | **yes** | The packscripts command to run, e.g. `pr gate <pr url>` |
| `github_token` | no | GitHub token forwarded as `PACKSCRIPTS_GITHUB_API_KEY`. Defaults to the built-in `github.token`. |
| `config` | no | Path or URL to the `packscripts.json` config file. Overrides the default config search. |
| `annotated_file` | no | Path or URL to the annotated mods JSON file. Overrides the value in `packscripts.json`. |
| `working_directory` | no | Working directory for packscripts. Required when `config` is a URL. Defaults to the workspace root. |
| `musl` | no | Set to `true` to use the musl-linked Linux binary instead of the default glibc one. |

### Outputs

| Output | Description |
|---|---|
| `annotated_file_path` | Resolved on-disk path of the annotated mods file (useful when it was fetched from a URL). |

### Example

```yaml
- uses: MalTeeez/packscripts@v1.4.8
  with:
    command: pr gate ${{ github.event.pull_request.html_url }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
```

## updating
- Create your .packscripts.env.json file (based on the .packscripts.env.json.example) in this repository.
- Fill the gh api key field with a github PAT from https://github.com/settings/personal-access-tokens/new (give it "Public" at minimum)

TBD