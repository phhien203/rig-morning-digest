# rig

Keeps a lane's lights on while nobody is in it: a heartbeat every minute, a status board, and
(next) a morning digest of what ran overnight.

```sh
cp .env.example .env   # set LANE_MARKER
pnpm install
pnpm dev               # http://localhost:8787
```

Working on it with an agent: start at [AGENTS.md](AGENTS.md).

## Review preview (GitHub Pages)

Publication is pending separate human approval. Do not configure Pages, add repository secrets,
run the deployment workflow, or publish a preview until that approval is given.

For local review, run `scripts/export-preview.sh` (Linux; Node 22, pnpm 12.16.1, curl and
`setsid` required). It starts the real server without reading `.env`, exports
`/digest/2026-10-28`, validates that it is self-contained with no scripts, and stops the server.
The default output is ignored `var/preview/index.html`; keep all local preview output under
`var/preview/` and never commit HTML. It inherits `LANE_MARKER` from the calling environment;
use `env -u LANE_MARKER scripts/export-preview.sh` for an unmarked copy. `PORT` may be overridden.

After approval, configure the repository's Pages source as **GitHub Actions**, add the
`LANE_MARKER` repository secret through GitHub's secure settings (never in a file or command
argument), and manually run **Manual Pages preview** on the reviewed branch. The workflow tests
and typechecks before exporting to runner temporary storage and deploying the Pages artifact.
`include_marker` defaults to true and fails if the secret is missing. The deployment's
`github-pages` environment exposes the public HTTPS URL; submit that URL and the plan issues
to the reviewer. There is no push-triggered deployment.

After review, manually run the same workflow with `include_marker: false` to overwrite the
same URL with “no marker set”, then verify the public page. Artifact retention is one day;
that does **not** remove the deployed site or its marker. Follow [ADR 0003](docs/adr/0003-previews-are-public-and-short-lived.md)
and record reviewer submission/cleanup status without copying HTML or marker values into git,
issues, or chat.
