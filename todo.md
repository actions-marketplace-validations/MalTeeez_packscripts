### ideas
- Suggestion of independent mods to check if they are needed (for lib mods)
- Add check for duplicate mod ids across files
- Source impl for curseforge & modrinth
- Add functionality to just provide download url, to append a new mod to map (download to temp, extract id, move to mods/)
- allow overriding the remote url for specific paths, with one that also fills from env variables

## doing
- ci pack fulltests

### ci notes
- We have to block merging until required PRs are merged, even if we can pull an artifact from the required PR and it works with that - we dont want to release something that depends on something thats not even available yet.
  > Fullpack test runs, uses artifacts from open PRs freely
  > If fullpack passes, a second job runs and validates that all cross-repo deps are either merged or have a released version available
  > Only if both pass does the PR get a green status that allows merging


#### Daily Build Pipeline

- [ ] Gate `:latest` publish behind fullpack test passing — daily image must not be published if the fullpack test fails
  > If a broken daily is published, every PR test running against `:latest` will fail, and it becomes impossible to distinguish "this PR broke it" from "the daily was already broken." The gate ensures `:latest` always represents a known-good state.
- [ ] Daily fullpack test must build from scratch (not based on an existing daily image)
  > Testing the daily by patching an older daily would mask incompatibilities introduced between the two. The daily test needs to reflect exactly what would be released.

#### Dep Graph Traversal (Cross-Repo)

- [ ] Get all PRs merged to the initial repo since the last daily (via GitHub API, using merge timestamp)
  > A PR can implicitly depend on changes that landed on default since the last daily without explicitly linking them — for example by branching from default after another PR merged, inheriting its changes, and therefore requiring that PR's cross-repo dependencies too. Collecting all merged PRs since the last daily and following their links catches these implicit transitive dependencies that no explicit linking syntax would ever cover.
- [ ] For each merged PR, record the post-merge commit on default branch
- [ ] Recursively follow cross-repo links, doing the same in each encountered repo
- [ ] Deduplicate per repo by taking the newest post-merge commit (newer commit is a superset of older on a linear default branch)
  > Since default only ever receives PR merges (no direct commits), the default branch is always linear. A newer commit therefore always contains all older commits, so taking the newest is always correct and complete.
- [ ] Build/grab artifact from each resolved commit
- [ ] Apply all artifacts on top of latest daily in dependency order

#### Pre-flight Checks (Same-Repo Deps)

Run these per-node during traversal, not just at the root PR — required PRs can themselves have same-repo deps.

> Same-repo deps never enter the graph traversal. They are a pre-flight only — if the checks pass, the dependency is already present in the branch artifact by definition. If they fail, there is nothing to resolve in CI; the developer must act first.

- [ ] For a same-repo dep targeting the **initial PR's branch**: fail until the dep PR is merged into that branch. If merged, it's already included in the branch artifact — do not add to graph
  > If the dep targets the same branch, the only way to have its changes present is for it to actually be merged in. There is no artifact we could apply to simulate this — the branch history itself needs to contain it.
- [ ] For a same-repo dep targeting **default**: fail until the initial PR's branch contains at least the merge commit of the dep PR on default
  > The dep's changes land on default when it merges. The initial PR's branch only gets them once it is updated from default. Until that sync happens, the initial PR's artifact does not contain the dep's changes, even though they exist on default.
- [ ] For a same-repo dep targeting **any other branch**: fail with a clear "unsupported target branch" error message
  > There is no defined policy for resolving deps that target arbitrary feature branches. Failing loudly forces the developer to restructure rather than silently producing an incorrect test.
- [ ] If all pre-flight checks pass, same-repo deps do not enter graph traversal — they are already present in the initial PR's artifact

#### Merged-But-Unreleased Dep Handling

- [ ] If a required PR has been merged but its repo hasn't cut a new release/tag yet, use the post-merge commit artifact from default branch CI instead
  > Every commit to default triggers a CI build, so a post-merge artifact should exist even if no release has been tagged. This covers the common case of teams batching releases over several days.
  > If the merged commit failed, walk from older commits -> newer commits until the first target workflow that didnt fail and use that. If none passed, fail
- [ ] If a required PR has been merged and a tag exists but the release is not yet published: fail with a clear message (do not poll indefinitely)
  > A tag without a published release means the artifact is not yet in a consumable state. Polling indefinitely would stall CI unpredictably; failing fast with a clear message lets the developer know exactly what is blocking them.

#### Upward Failure Propagation

- [ ] If the most recent commit of a required PR's workflow fails, fail the dependent PR's CI as well
  > Testing against a broken dependency would produce meaningless results — failures could be caused by the dependency, not the PR under test. There is no point running the fullpack test in this state.
- [ ] Error message should link directly to the failing workflow on the dependency PR
  > Without a direct link, the developer has to manually hunt down which dependency is broken and why. A direct link makes the failure immediately actionable.

#### Waiting on Dep PR Artifacts

- [ ] If a required PR's workflow has not yet produced an artifact, wait with a timeout
  > The dependency's CI may simply still be running. Failing immediately would cause unnecessary re-triggers; a short wait covers the normal case of a dependency that is mid-build.
- [ ] On timeout, fail with a clear message indicating which PR's artifact was awaited and link to it
- [ ] On failure/timeout, developer must manually re-trigger (document this expectation)
  > Automatic retries across a chain of dependent PRs would be complex and unpredictable. Manual re-trigger is simple and keeps the developer in control of when the test runs.

#### Constraints / Guardrails

- [ ] Cross-repo linked PRs must be from the same GitHub org/owner — other owners are rejected by default (already noted as solved, but ensure it's enforced explicitly with a clear error)
  > Allowing external forks to inject artifacts into the test pipeline would be a security risk — arbitrary code could be introduced into the fullpack test environment.