/**
 * Thin wrappers around git plumbing commands.
 *
 * These exist because isomorphic-git cannot read packfiles larger than 2 GiB: a pack that big forces the v2 index to
 * carry the 64 bit "large offset" table, which isomorphic-git's index parser never skips, so it picks up garbage where
 * the packfile checksum should be and aborts with "Packfile trailer mismatch". Pack repos cross that line quickly once
 * they collect a few hundred snapshots, so anything touching git objects goes through the git binary first and only
 * falls back to isomorphic-git when git isn't on PATH.
 */

export interface git_tree_diff_entry {
    filepath: string;
    status: 'added' | 'deleted' | 'modified';
    old_oid: string | undefined;
    new_oid: string | undefined;
}

const NULL_OID = '0'.repeat(40);

async function run_git(dir: string, args: string[]): Promise<{ ok: boolean; stdout: Uint8Array; stderr: string }> {
    try {
        const proc = Bun.spawn(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
        const [stdout, stderr] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text()]);
        await proc.exited;

        return { ok: proc.exitCode === 0, stdout: new Uint8Array(stdout), stderr };
    } catch (error) {
        return { ok: false, stdout: new Uint8Array(), stderr: String(error) };
    }
}

async function run_git_text(dir: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const { ok, stdout, stderr } = await run_git(dir, args);
    return { ok, stdout: new TextDecoder().decode(stdout), stderr };
}

export async function is_git_available(dir: string): Promise<boolean> {
    const { ok } = await run_git(dir, ['rev-parse', '--git-dir']);
    if (!ok) {
        console.warn('W: For some (weird) reason, git is not availble in this cli context. Falling back to a slower approach.');
    }
    return ok;
}

/**
 * Resolve a branch, tag or (short) commit sha to a full commit sha, undefined if git can't resolve it.
 */
export async function git_resolve_ref(dir: string, ref: string): Promise<string | undefined> {
    const { ok, stdout } = await run_git_text(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    const sha = stdout.trim();

    return ok && /^[a-f0-9]{40}$/.test(sha) ? sha : undefined;
}

/**
 * Map every non-tree path of a commit to its object id, mirroring a full isomorphic-git TREE walk.
 * Gitlinks (submodules) are included with their commit sha, exactly like the walker reports them.
 */
export async function git_list_tree(dir: string, commit_sha: string): Promise<Map<string, string> | undefined> {
    const { ok, stdout, stderr } = await run_git_text(dir, ['ls-tree', '-r', '-z', '--full-tree', commit_sha]);
    if (!ok) {
        console.warn(`W: Failed to list tree of ${commit_sha} via git: ${stderr.trim()}`);
        return undefined;
    }

    const file_oids = new Map<string, string>();
    for (const record of stdout.split('\0')) {
        if (record === '') continue;

        // <mode> SP <type> SP <oid> TAB <path>
        const match = record.match(/^\d+ (\w+) ([a-f0-9]+)\t(.+)$/s);
        if (match == undefined || match[1] === 'tree') continue;

        file_oids.set(match[3] as string, match[2] as string);
    }

    return file_oids;
}

/**
 * Diff two commits path by path, mirroring a two tree isomorphic-git walk.
 * Renames stay split into an add and a delete, since the packaging plan is built per path.
 */
export async function git_diff_tree(dir: string, base_commit_sha: string, target_commit_sha: string): Promise<git_tree_diff_entry[] | undefined> {
    const { ok, stdout, stderr } = await run_git_text(dir, ['diff-tree', '-r', '-z', '--no-renames', '--no-commit-id', base_commit_sha, target_commit_sha]);
    if (!ok) {
        console.warn(`W: Failed to diff ${base_commit_sha}..${target_commit_sha} via git: ${stderr.trim()}`);
        return undefined;
    }

    // Records alternate between ":<srcmode> <dstmode> <srcoid> <dstoid> <status>" and the path they belong to
    const records = stdout.split('\0').filter((record) => record !== '');
    const diffs: git_tree_diff_entry[] = [];

    for (let i = 0; i < records.length - 1; i += 2) {
        const meta = (records[i] as string).match(/^:\d+ \d+ ([a-f0-9]+) ([a-f0-9]+) (\w)$/);
        const filepath = records[i + 1] as string;
        if (meta == undefined) continue;

        const old_oid = meta[1] === NULL_OID ? undefined : meta[1];
        const new_oid = meta[2] === NULL_OID ? undefined : meta[2];

        // Mode-only changes keep the same oid; the isomorphic-git walker never reported those, so skip them here too
        if (old_oid === new_oid) continue;

        diffs.push({
            filepath,
            status: old_oid == undefined ? 'added' : new_oid == undefined ? 'deleted' : 'modified',
            old_oid,
            new_oid,
        });
    }

    return diffs;
}

/**
 * Read a single blob as it existed at a commit, undefined if git can't (missing path, missing git, ...).
 */
export async function git_read_blob_at(dir: string, commit_sha: string, filepath: string): Promise<Uint8Array | undefined> {
    const { ok, stdout } = await run_git(dir, ['cat-file', 'blob', `${commit_sha}:${filepath}`]);

    return ok ? stdout : undefined;
}
