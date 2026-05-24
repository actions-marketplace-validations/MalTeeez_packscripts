const GH_RELEASE_URL_PATTERN =
    /github\.com\/(?:repos\/)?(?<owner>[^\/]+)(?:\/(?<project>[^\/]+)(?:\/(?<primary>releases|pull|actions|tree|commit)(?:\/(?<secondary>tag|download|\d+.*?|runs|[\w-]+?)(?:\/(?<key>[^\/]+)(?:\/(?<asset>[^\/]+)(?:\/(?<fifth>[^\/]+))?)?)?)?)?)?$/m;
// https://regex101.com/?regex=github%5C.com%5C%2F%28%3F%3Arepos%5C%2F%29%3F%28%3F%3Cowner%3E%5B%5E%5C%2F%5D%2B%29%28%3F%3A%5C%2F%28%3F%3Cproject%3E%5B%5E%5C%2F%5D%2B%29%28%3F%3A%5C%2F%28%3F%3Cprimary%3Ereleases%7Cpull%7Cactions%7Ctree%29%28%3F%3A%5C%2F%28%3F%3Csecondary%3Etag%7Cdownload%7C%5Cd%2B.*%3F%7Cruns%7C%5B%5Cw-%5D%2B%3F%29%28%3F%3A%5C%2F%28%3F%3Ckey%3E%5B%5E%5C%2F%5D%2B%29%28%3F%3A%5C%2F%28%3F%3Casset%3E%5B%5E%5C%2F%5D%2B%29%28%3F%3A%5C%2F%28%3F%3Cfifth%3E%5B%5E%5C%2F%5D%2B%29%29%3F%29%3F%29%3F%29%3F%29%3F%29%3F%24&testString=https%3A%2F%2Fgithub.com%2FGTNewHorizons%2FGT5-Unofficial%0Ahttps%3A%2F%2Fgithub.com%2FGTNewHorizons%2FGT5-Unofficial%2Factions%2Fruns%2F25946608912%2Fjob%2F76275891293%3Fpr%3D6655%0Ahttps%3A%2F%2Fgithub.com%2FGTNewHorizons%2FGT5-Unofficial%2Factions%2Fruns%2F25946608912%0Ahttps%3A%2F%2Fgithub.com%2FGTNewHorizons%2FGT5-Unofficial%2Fpull%2F6655%0Ahttps%3A%2F%2Fgithub.com%2FGTNewHorizons%2FGT5-Unofficial%2Freleases%2Ftag%2F5.09.52.512-pre%0Ahttps%3A%2F%2Fgithub.com%2FGTNewHorizons%2FGT5-Unofficial%2Freleases%2Fdownload%2F5.09.52.512-pre%2Fgregtech-5.09.52.512-pre-sources.jar%0Ahttps%3A%2F%2Fgithub.com%2FGTNewHorizons%2FGT5-Unofficial%2Ftree%2Flne-fixes%0Ahttps%3A%2F%2Fapi.github.com%2Frepos%2FGTNewHorizons%2FHodgepodge%2Factions%2Fartifacts%2F6860990429%2Fzip&flags=gm&flavor=javascript&delimiter=%2F

export function parse_gh_url(url: string):
    | {
          owner: string;
          project: string;
          primary?: 'releases' | 'actions' | 'pull' | 'tree';
          secondary?: 'tag' | 'download' | 'runs' | string;
          key?: string;
          asset?: string;
          fifth?: string;
      }
    | undefined {
    const match = url.match(GH_RELEASE_URL_PATTERN);

    if (match == null || match.groups == undefined) {
        return undefined;
    }

    return {
        owner: match.groups['owner'] as string,
        project: match.groups['project'] as string,
        primary: match.groups['primary'] as 'releases' | 'actions' | 'pull' | 'tree' | undefined,
        secondary: match.groups['secondary'] as 'tag' | 'download' | 'runs' | string | undefined,
        key: match.groups['key'] as string | undefined,
        asset: match.groups['asset'] as string | undefined,
        fifth: match.groups['fifth'] as string | undefined,
    };
}

// GitHub PR URL base pattern - matches the URL up to and including the PR number
const GH_URL = String.raw`https://github\.com/[^/]+/[^/]+/pull/\d+`;

// GitHub shorthand PR reference: #123 or owner/repo#123
const GH_SHORTHAND = String.raw`(?:[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+)?#\d+`;

// Combined pattern for either form
const GH_REF = `(?:${GH_URL}|${GH_SHORTHAND})`;

// Each alternation handles a specific delimiter pair, consuming everything up to the closing delimiter.
// The undelimited case comes last so delimited cases take priority.
function make_delimited(pattern: string): string[] {
    return [
        String.raw`\(${pattern}[^\s,)]*\)`,       // (ref)  - parentheses
        String.raw`\[${pattern}[^\s,\]]*\]`,      // [ref]  - square brackets
        String.raw`\{${pattern}[^\s,}]*\}`,       // {ref}  - curly braces
        String.raw`<${pattern}[^\s,>]*>`,         // <ref>  - angle brackets
        String.raw`\`${pattern}[^\s,\`]*\``,     // `ref`  - backticks
        String.raw`"${pattern}[^\s,"]*"`,         // "ref"  - double quotes
        String.raw`'${pattern}[^\s,']*'`,         // 'ref'  - single quotes
        String.raw`${pattern}[^\s,)}\]>\`"'\\]*`, // ref    - undelimited, stops before any closing delimiter
    ];
}

const DELIMITED = [
    ...make_delimited(GH_URL),
    ...make_delimited(GH_SHORTHAND),
].join('|');

const REQUIRED_PR_PATTERN = new RegExp(
    // Prefix alternatives:
    // 1. "depends/relies on (pr)"
    // 2. "requires/required (qualifier) (pr)" - pr optional
    // 3. "(qualifier) (pr) requires/required" - reversed word order e.g. "this pr requires"
    // 4. "req" - just standalone
    String.raw`(?:` +
        String.raw`(?:depends|relies)[ \t]*on[ \t]*(?:\bpr\b[ \t]*)?` +
        String.raw`|require(?:s|d)[ \t]*(?:(?:this|other|parent|sister|a|the)[ \t]*)?(?:\bpr\b[ \t]*)?` +
        String.raw`|(?:(?:this|other|parent|sister|a|the)[ \t]*)?\bpr\b[ \t]*require(?:s|d)` +
        String.raw`|\breq\b` +
        String.raw`)` +
        // Optional colon separator with surrounding horizontal whitespace
        String.raw`[ \t]*:?[ \t]*` +
        // Assert that a GitHub PR URL or shorthand follows before consuming anything into pr_list.
        // Accounts for optional opening delimiter before the ref (for weird markdown syntax).
        String.raw`(?=[({\[<\`"']?(?:https://github\.com/|(?:[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+)?#\d))` +
        // Capture the full list of refs into pr_list.
        // Each ref can be delimited or bare, optionally followed by a comma separator.
        // The outer + allows multiple comma-separated refs.
        String.raw`(?<pr_list>(?:(?:${DELIMITED})(?:[ \t]*,[ \t]*)?)+)`,

    'gi',
);

function strip_ref_delimiters(ref: string): string {
    return ref.trim().replace(/^[({\[<`"']|[)}\]>`"']$/g, '');
}

type ExtractedRef =
    | { type: 'url'; value: string }
    | { type: 'shorthand'; value: string };

function extract_refs_from_pr_list(pr_list: string): ExtractedRef[] {
    return pr_list
        .split(/[ \t]*,[ \t]*/)
        .map(strip_ref_delimiters)
        .flatMap((ref): ExtractedRef[] => {
            if (ref.startsWith('https://')) {
                return [{ type: 'url', value: ref }];
            }
            // Match optional owner/repo prefix + #number
            if (/^(?:[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)?#\d+$/.test(ref)) {
                return [{ type: 'shorthand', value: ref }];
            }
            return [];
        });
}

export type RequiredPR = {
    /** Resolved GitHub PR URL, if known */
    url: string | null;
    /** Raw shorthand like #123 or owner/repo#123, if that's what was found */
    shorthand: string | null;
    /**
     * True when the reference is a bare shorthand (#123 / owner/repo#123).
     * GitHub shorthands can point to issues as well as PRs, so we cannot
     * confirm this is actually a PR without an API call.
     */
    uncertain: boolean;
};

export type RequiredPRMatch = {
    refs: RequiredPR[];
    raw_match: string;
};

export function extract_required_prs(body: string): RequiredPRMatch[] {
    const results: RequiredPRMatch[] = [];

    for (const match of body.matchAll(REQUIRED_PR_PATTERN)) {
        const pr_list = match.groups?.pr_list;
        if (!pr_list) continue;

        const extracted = extract_refs_from_pr_list(pr_list);

        const refs: RequiredPR[] = extracted.map((ref) => {
            if (ref.type === 'url') {
                return { url: ref.value, shorthand: null, uncertain: false };
            } else {
                return { url: null, shorthand: ref.value, uncertain: true };
            }
        });

        if (refs.length > 0) {
            results.push({ refs, raw_match: match[0] });
        }
    }

    return results;
}

// export function test_body_match() {
//     console.log(extract_required_prs(`req https://github.com/a/b/pull/734, #745, a/b#812\\r\\n<img width="364" height="367" alt="image" src="https://github.com/user-attachments/assets/becdec96-85de-4f64-bca3-e9a89967fa0b" />\\r\\n`)[0]?.refs)
// }