# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in `leifengyang/agent-project`. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --json title,state,body,comments,labels,author,createdAt`, without a `--jq` projection. Fetch all comments with `gh api --paginate --slurp 'repos/{owner}/{repo}/issues/<number>/comments?per_page=100' --jq '[.[][]]'` and use that complete array in place of the view's comments. Retain each comment's body, author (`user` in REST), and creation/update timestamps. Piped, `gh issue view --comments` prints the comments alone, without the body.
- **List issues**: `gh api --paginate --slurp 'repos/{owner}/{repo}/issues?state=open&per_page=100' --jq '[.[][] | select(.pull_request == null)]'`. Set the query's `state` and URL-encoded `labels` filters as needed. Keep full records, including `user`, `created_at`, labels, body, and dependency metadata. For each issue, obtain the full **Read an issue** result and all comment pages before triage classification. Consume every issue and comment page before filtering or deciding no issues match. Any failed request is an error, not exhaustion; do not use a partial listing.
- **List children** (implementation): use **List issues** to fetch all open issues and retain those whose `## Parent` section contains exactly the requested issue reference. Compare resolved repository and issue identity, not a substring (`#12` is not `#123`, and a reference elsewhere in the body is not a parent). Also fetch all pages of `gh api --paginate --slurp 'repos/{owner}/{repo}/issues/<number>/sub_issues?per_page=100' --jq '[.[][]]'` and retain open sub-issues. Combine and deduplicate by repository and issue number, preserving full records. Skip the native request only when sub-issues are known unavailable, not on an arbitrary request failure. Read each child's full body, state, and labels, then use **Resolve blockers**; a malformed or conflicting parent declaration is unknown, not a match.
- **Resolve blockers**: use the procedure below; missing dependency metadata never means zero.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "<name>"` or `--remove-label "<name>"`
- **Create a missing label**: `--label` / `--add-label` fails on a label the repo doesn't have yet. Create it first with `gh label create "<name>" --force`.
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --json title,state,body,comments,labels,author,createdAt`, without a `--jq` projection, and `gh pr diff <number>` for the diff. Replace the view's comments with all pages from the same issue-comments endpoint used by **Read an issue**, retaining author and timestamps.
- **List external PRs for triage**: `gh pr list` has no author association field, so use `gh api --paginate --slurp 'repos/{owner}/{repo}/pulls?state=open&per_page=100' --jq '[.[][] | select(.author_association | IN("CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE"))]'`. This drops `OWNER`/`MEMBER`/`COLLABORATOR` but keeps the full PR records. Obtain every retained PR's full JSON fields and all comment pages as in **Read a PR** before classification; the diff is needed only when triaging that PR. A failed request is an error, not exhaustion; never classify a partial listing.
- **Comment / label / close**: `gh pr comment`, `gh pr close`, and `gh pr edit` with `--add-label` or `--remove-label`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve it in one call with `gh api 'repos/{owner}/{repo}/issues/42' --jq 'if .pull_request then "pr" else "issue" end'`, which answers for both kinds.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the issue"

Run the **Read an issue** command above.

## Resolving implementation blockers

For every child, read its complete body and inspect any top-level `Blocked by:` line even when native dependencies exist. A valid nonnegative integer `issue_dependencies_summary.blocked_by` is the native count of open blockers: a positive count blocks the child. If the count is absent or invalid, fetch all pages with `gh api --paginate --slurp 'repos/{owner}/{repo}/issues/<number>/dependencies/blocked_by?per_page=100' --jq '[.[][]]'` and inspect each dependency's state. Only `closed` satisfies a dependency; missing or unknown state blocks eligibility.

When native dependencies are known unavailable, use the textual fallback instead. A failed native read alone does not establish unavailability; report it as unknown. Parse every reference in `Blocked by:` and read each issue, including closed issues, with **Read an issue** (use an explicit repository for cross-repository references). Every referenced issue must be confirmed closed. A missing line in a completely read fallback body declares no textual blockers; an empty/malformed line, unresolved reference, unreadable issue, or incomplete response is unknown, never zero. The child is eligible only when both its applicable native blockers and textual blockers are satisfied.

API reference: [GitHub issue dependencies](https://docs.github.com/en/rest/issues/issue-dependencies) and [sub-issues](https://docs.github.com/en/rest/issues/sub-issues).

## Wayfinding operations

Used by `/wayfinder`; `/to-tickets` uses **Blocking** too. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Destination / Notes / Decisions so far / Added so far / Not yet specified / Out of scope body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's children with `gh api repos/<owner>/<repo>/issues/<map>/sub_issues --paginate` (or read the map's task list where sub-issues aren't enabled). Keep the open ones (`state == "open"`), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line), an assignee, or an unreleased claim comment; first in map order wins.
- **Claim**: assignment is not exclusive acquisition. Use `/wayfinder`'s single-coordinator protocol. Only the coordinator rechecks eligibility (including every comment page, fetched as in **List issues**) and writes `gh issue comment <n> --body "Claimed by: <worker-session-id>"`, then `gh issue edit <n> --add-assignee <worker-login>`. Read back both writes before granting that ticket to that session. An unreleased claim comment reserves the ticket even if assignment failed; the worker waits for the coordinator's grant before work.
- **Release**: only after the prior worker is confirmed stopped, the coordinator removes the assignee and appends `Claim released: <worker-session-id>` with **Comment on an issue**. Claims without a matching later release remain active until the ticket closes.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
