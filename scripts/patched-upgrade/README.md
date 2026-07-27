# Patched upgrade pipeline

Local-only tooling (never upstream) for running a kimi binary built from an
upstream release plus local patch branches. This directory holds the code and
is versioned on the `local/upgrade-hook` branch (pushed to the fork); the
live copies used at runtime are in `~/.kimi-code/`.

- `upgrade-with-patches.sh` — the pipeline. `kimi upgrade` (patched via this
  same branch) delegates to `~/.kimi-code/upgrade-with-patches.sh` when it
  exists; the script rebases the active patch branches onto the target release
  tag, rebuilds, and atomically swaps `~/.kimi-code/bin/kimi`. Idempotent:
  no rebuild when the release AND the patch fingerprint are unchanged.
- `install.sh` — installs the script into `~/.kimi-code/` (keeps an existing
  copy unless `FORCE=1`) and seeds an empty patch registry if none exists.

## The patch registry

`~/.kimi-code/local-patches.json` is live-only config and is deliberately NOT
versioned in the repo: its contents describe branches (already git refs,
recoverable from the fork's branch list and `gh pr list`), and committing
registry bookkeeping to `local/upgrade-hook` would change that branch's head
and force a pointless binary rebuild. Format:

```json
{
  "patches": [
    { "branch": "fix/some-thing", "pr": 1234, "status": "active" },
    { "branch": "local/upgrade-hook", "pr": null, "status": "active", "localOnly": true }
  ]
}
```

- `branch`: a local branch (preferred) or one fetched from origin.
- `pr`: upstream PR number, used for merged-PR detection (the script marks
  the entry `"merged"` and stops applying it once the PR merges). `null`
  skips the check.
- `status`: `active` entries are applied; anything else is skipped.
- `localOnly`: informational — the branch is never pushed anywhere except
  the fork.

The script additionally writes per-machine `state` (base release, binary
hash, build time) into this file, which is another reason it stays out of
git.

## Setup on a new machine

```sh
cd ~/workspace/kimi-code
git fetch origin
git checkout local/upgrade-hook        # or: git show origin/local/upgrade-hook:scripts/patched-upgrade/...
scripts/patched-upgrade/install.sh
$EDITOR ~/.kimi-code/local-patches.json  # list your patch branches
kimi upgrade                           # rebuilds the patched binary
```

## Notes

- `KIMI_LOCAL_UPGRADE_SCRIPT` overrides the script path the CLI hook uses;
  `KIMI_PATCH_REPO` / `KIMI_PATCH_STATE` override the script's defaults;
  `DRY_RUN=1` prints the plan without building; `FORCE=1` rebuilds anyway.
- The script fails fast when `node --version` does not match `.nvmrc` — the
  SEA build needs the repo-pinned Node, not an arbitrary system Node.
