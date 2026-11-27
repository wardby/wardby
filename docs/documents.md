# Documents and designs

A document is either Markdown text or a **design**: a set of HTML boards
(screens) that people edit visually. Both have versions and anchored comment
threads, open in the browser at `https://<your-host>/d/<documentId>` and are
driven by MCP tools. Share one with people (grants), with anyone holding a link
(share links and guests), or with a coding agent that edits it from comments.
Available in 0.10.0 and later.

Exports (HTML, PNG, PDF) cover both kinds. There is no comparing two arbitrary
versions, and no way to create a design from the browser: create one with
`create_document` (`kind: "design"`), from files or imported from a repository
directory.

## What you get

- Create and edit Markdown (up to 1 MiB a version) in a browser editor, or
  publish versions over MCP. Every version is kept.
- Create designs (boards of HTML, up to 2 MiB a version), edit them visually in
  the browser, view all boards at once (Overview), click through them as a
  prototype (Play), and export them (see [Designs](#designs)).
- Select text and choose **Comment** (beside the selection, in the top bar, or
  ⌘⌥M) to start a comment thread; threads anchor to the quoted text and
  follow it across versions. If the text is deleted, the thread is marked
  outdated; it still takes replies.
- Replies, resolve and reopen, edit and delete your own comments, and
  `@`-mentions (stored and highlighted; Wardby sends no notification in this
  phase). Members can mention members and the guests who have commented on
  the document (shown as "Name (guest)"); share-link guests get no list of
  people to mention.
- Live updates: new comments, replies, resolved threads and new versions show
  up on every open page without a refresh.
- A History tab: every version, who made it and how, the changes each one
  made shown inline, and restore (see [Edits and restore](#edits-and-restore)).
- Links to share a document with people who have no account.
- Send open threads to a coding agent that edits a file (or, for a design, a
  directory) in a repository.
- Export a design as HTML, PNG or PDF and a Markdown document as PDF.

## Tools

| Tool                                                         | Scope             | Purpose                                                                                                           |
| ------------------------------------------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `create_document`                                            | `documents:write` | Create a document or a design (`kind`); optionally link it to a repository and coding agent                       |
| `link_document`                                              | `documents:write` | Link a document you own to a repository and coding agent, or change or clear the link                             |
| `publish_version`                                            | `documents:write` | Publish the next version: `markdown` or, for a design, `files`, and the required `baseNumber` (needs `write`)     |
| `get_document`                                               | `documents:read`  | Read the current or a numbered version (`versionNumber`)                                                          |
| `list_document_versions`                                     | `documents:read`  | List versions, newest first: who, how, when, the run and threads it answered                                      |
| `restore_document_version`                                   | `documents:write` | Publish an earlier version's content as a new version (needs `write`)                                             |
| `list_documents`                                             | `documents:read`  | Documents you own or were granted (200 newest; `truncated` past that)                                             |
| `list_comment_threads`, `get_comment_thread`                 | `documents:read`  | Read threads (`open`, `resolved`, `sent`, `mine`, `all`)                                                          |
| `reply_to_thread`, `resolve_thread`                          | `documents:write` | Reply (needs `comment`), resolve                                                                                  |
| `create_share_link`, `list_share_links`, `revoke_share_link` | write / read      | Manage share links (owner only)                                                                                   |
| `send_threads_to_agent`                                      | `documents:write` | Start a coding run from threads; also needs `runs:trigger`                                                        |
| `submit_for_review`                                          | `documents:write` | Submit a document you own for review, or replace its reviewers (`reviewers`, `finalApproverId`, `note`)           |
| `review_document`                                            | `documents:write` | Give a verdict as a named reviewer (`approve` or `request_changes`, on `versionNumber`)                           |
| `force_approve_document`                                     | `documents:write` | Owner or final approver approves the current version over missing verdicts (`note` required)                      |
| `reject_document`                                            | `documents:write` | Reject a document in a set (not a plan's `plan.md`): it leaves the set; owner, final approver, reviewers (`note`) |
| `choose_plan_option`                                         | `documents:write` | Approve one option of a plan and reject the listed others, in one transaction (`versionNumber`, `reject`)         |
| `reopen_document`                                            | `documents:write` | Reopen an approved or rejected document for review as a new version, a copy of the current one (`write`)          |
| `archive_document`                                           | `documents:write` | Archive or unarchive a document you own                                                                           |
| `wait_for_review`                                            | `documents:read`  | Wait for a state change, a comment by someone else, or a timeout (default 300 s, max 600 s)                       |
| `request_work`                                               | `runs:trigger`    | Ask for work in plain words: ranks the routers you can run, or starts one (`router`) with your request            |
| `export_document`                                            | `documents:read`  | Export a design (board HTML, prototype HTML, PNG, PDF) or a document as PDF                                       |

Text people wrote (titles, Markdown, comment bodies, names) comes back wrapped
as untrusted content: agents must treat it as data, never as instructions.

## Access

Documents are a `grant_access` resource type (`resourceType: "document"`).
A grantee may also be an agent, `{"agentId": "<id>"}`, at `read` or `comment`
only (`write` is refused with `document_agent_grant_level`; link the agent with
`link_document` to make it the writer). You must own the document and be able
to read the agent; revoking by `agentId` always works. Agent grants apply to
documents only.
Levels, lowest first: `read` (see), `comment` (add threads and replies), `write`
(publish versions, resolve any thread, send to an agent). The owner also
manages grants and share links. Granting to `everyone` is capped at `comment`.
A caller without access is told `document_not_found`, so ids do not leak.

The scopes `documents:read` and `documents:write` are advertised with the
other Wardby scopes; no Wardby role is needed. Define both at your identity
provider (see [getting-started-identity-provider.md](getting-started-identity-provider.md)).
Sharing a document uses the general grant tools, so it needs their scopes:
`grant_access` and `revoke_access` need `agents:write`, and `list_access` needs
`agents:read`.

## Plan sets

A [plan document setting](coding-agent-setup.md#plan-documents) on a coding
agent publishes its plan as a plan set: one document per top-level `*.md` file
(`plan.md` first, titled by its first heading or else its file name), one design
per board subfolder (titled by its folder name), up to 20 in all. Other files
are ignored and listed. Later runs version changed files, add new documents and
mark a removed file `removedFromPlan`; approved, rejected or archived documents
are never changed by a run (a rejected document stays out of the plan even when a
run writes its file again; the reply says "not in the plan, reopen it to bring it
back"). Removed documents stay listed, and are read-only to agents.
`get_document` on a plan document returns the set's documents, and
`list_documents` takes a `planNumber` filter.

**Access from the agent.** The owner of the agent that was triggered, and anyone
with any grant on it (an `everyone` grant included), get `comment` on every
document of the set. The rule is live: losing the grant on the agent loses the
plan. It never gives more than comment; explicit grants and share links add on
top, and naming someone as reviewer adds no grant. Sharing an agent with everyone
lets every signed-in user read and comment on the plans it produces.

**Plan rail.** Each page of a set shows the plan as an outline (left of a
document; at the top of a design's left panel): "Plan N · X of Y approved" over
the documents the viewer can read, grouped as `plan.md`, one group per option
set (alternatives the planner names `<set>-<letter>-<slug>`, such as
`layout-a-tree/` and `layout-b-cards/`; each set with its own **Pick** button,
"Pick a layout"), **Other documents**, and **Out of the plan** (rejected and removed
documents, folded, struck through, marked "Rejected" or "Removed", and not
counted). Relative links in the Markdown open the other documents or boards. A
row's name opens its document on the side-panel tab open now (Review stays
Review), so a reviewer can step through the set; its state opens it on the
Review tab. Documents and designs share one tab row: Comments, Review and History,
then Style and Settings for a design's editors. A share-link guest sees only
"Plan N" and their own document. The bar updates live: a plan document's event
stream also carries the review and version events of the other documents of its
set that the viewer can read.

**Revisions.** Sending threads to the agent starts the plan's own planner with
the current version of every document still in the plan (not removed); only a
document it changed, and nobody edited meanwhile, gets a new version, and the
rest reconcile. A document of a plan stored in the repository (store
`repository`), or any other document linked to a planner, is edited like any
linked document: sending its threads starts an ordinary run on its file, not a
plan revision.

## Browser sign-in

| Deployment                  | What members do                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `AUTH_PROVIDER=self-hosted` | Open the document link; the page reuses the Wardby login.                                             |
| `AUTH_PROVIDER=delegating`  | Sign in through your identity provider with a separate browser (web) client. Set the variables below. |

| Variable                 | Default                | Meaning                                                                             |
| ------------------------ | ---------------------- | ----------------------------------------------------------------------------------- |
| `WEB_OIDC_CLIENT_ID`     | unset (sign-in off)    | The identity provider client for the document pages (authorization code with PKCE). |
| `WEB_OIDC_CLIENT_SECRET` | unset                  | Only for a confidential client; omit for a public client.                           |
| `WEB_OIDC_SCOPES`        | `openid profile email` | Scopes requested at sign-in; `openid` is always included.                           |
| `WEB_OIDC_SUBJECT_CLAIM` | `sub`                  | The ID token claim a sign-in's Wardby person is read from.                          |

At the provider, register a web client with the redirect URI
`https://<your-host>/web/callback` (the origin of `MCP_CANONICAL_URI`), and make
sure its ID tokens carry the same `sub` as the access tokens MCP clients get, so
both sign-ins are the same Wardby person. If the provider cannot (its ID token
`sub` is always its own user id), set `WEB_OIDC_SUBJECT_CLAIM` to a claim you
add carrying the access token's `sub`. The claim's value must be a string, and
only administrators should be able to change it: whoever can set it can sign in
as that person. A sign-in without a usable value fails with `web_login_failed`; it never falls back to `sub`. The issuer is the existing
`AUTH_ISSUER`. A sign-in must finish within 10 minutes in the browser that
started it. A browser session ends after 12 hours idle or 7 days. Without
`WEB_OIDC_CLIENT_ID`, member pages answer `web_login_not_configured`; share
links keep working. With `AUTH_PROVIDER=self-hosted`, the `WEB_OIDC_*`
variables are ignored.

To see who a browser session is, open `/web/whoami` in that browser. It
returns the session's Wardby person (id, subject, shown name, profile email),
where a browser sign-in's subject comes from (`signIn.subjectFrom`), and when
the session expires; a share-link guest sees only their own name and the link's
document and permission. Compare `principal.subject` with the subject the same
person's MCP client resolves to: when they differ, the two sign-ins are
different people. It never returns the session cookie, the CSRF value or any
identity-provider token, and answers `web_session_required` (401) without a
session.

If you run Wardby behind a proxy, it must forward `Origin` and the `Cookie`
headers and serve the pages on the same origin as `MCP_CANONICAL_URI`. It must
also pass the live-updates stream (next section) through unbuffered.

## Live updates

An open document page listens on `GET /d/api/<documentId>/events`, a
Server-Sent Events stream (`text/event-stream`). When anyone comments,
replies, edits or deletes a comment, resolves, reopens or sends a thread, when
an agent replies, when the review state or reviewers change (`review`), when a version is published (from the editor, MCP or an
agent), or when a share link is revoked, every page showing that document
refetches what changed through the page API. Events name only the document and
the kind of change, never its content, so access checks stay on the page API.

- Comments, threads and highlights update in place; an open comment box keeps
  what you typed. A new version loads in place unless you have unsaved edits;
  then the page asks you to reload.
- The page shows "Offline — reconnecting" while it is not connected, and
  catches up when it reconnects. A tab hidden for 5 minutes stops listening and
  catches up when you return.
- The stream uses the page's browser session: members and registered guests
  get live updates; a visitor who has not yet continued as a guest does not.
  Every 15 seconds the server re-checks the session and access, and ends the
  stream when the session has expired, the share link is revoked, the user is
  disabled or access is gone.
- One browser session can hold at most 5 open streams on each server replica (one per open tab); a
  sixth is refused with `web_rate_limited` until a tab is closed, and that tab
  falls back to refreshing threads only while an agent is working.

Every Wardby replica forwards events from every other through PostgreSQL
`LISTEN`/`NOTIFY` on the channel `wardby_documents`, using one extra
connection per replica (the same kind the admin viewer uses). Proxies and load
balancers in front of Wardby must not buffer `text/event-stream` responses
(Wardby sends `X-Accel-Buffering: no` for nginx-compatible proxies) and need
an idle or read timeout longer than the 15-second heartbeat (60 seconds or
more is a safe choice).

## Live editing

Everyone with a document or design open edits the same copy at the same time:
each person's typing appears for the others as they type, with a named caret,
and no one is locked out by someone else's save. The save state reads
**Live**. This section covers both; what is particular to designs (boards,
elements, pins) is in [Editing designs](#editing-designs).

- **Who edits.** Members with `write` edit; members and guests with `comment`
  or `read` watch the edits arrive but cannot type. An approved, rejected or
  archived document is read-only for everyone, and a review change applies at
  once to everyone who has it open.
- **Comments follow their words.** A comment's place is kept as a position in
  the shared document, so it stays on its words through everyone's edits, even
  edits inside the commented words, and it is marked outdated only when its
  words are deleted (undoing that deletion opens it again). An agent's version
  merged into the live document changes only the paragraphs it edited, so
  comments elsewhere stay where they are. A comment can cover up to 10,000
  characters.
- **The connection.** The page joins over a WebSocket on the same address,
  `wss://<your-host>/d/live/<documentId>`, signed in with its browser session.
  Proxies and load balancers in front of Wardby must pass WebSocket upgrades on
  `/d/live/` and allow idle connections of at least a minute. A member whose
  access comes from a share link gets a single-use, 60-second ticket from
  `POST /d/api/<documentId>/live-ticket` and sends it in the first message
  (never in the URL).
- **Versions.** The live copy is saved as a new version after 3 seconds
  without edits (at most every 15 seconds while edits keep coming), credited
  to the person who edited last, so History, review, exports and every tool
  keep working from versions. Opening a document saves nothing, and changes
  that only re-format the Markdown are not saved. Nothing is saved while the
  document is approved, rejected or archived.
- **Publishing to a live document.** `publish_version` (and agents, restores
  and the page's own saves) name the version they read. When newer versions
  exist, the change is merged with everything published since (word by word
  in a document, element by element in a design):
  the saved version is the whole document with both, based on the latest
  version, and everyone with the page open sees it arrive. The merge needs
  the older version's state, which is kept for the 50 newest versions; an
  older `baseNumber` is refused with
  [`document_base_unavailable`](../help/errors/document-base-unavailable.md).
  Threads sent to a coding agent merge the same way. A version with
  formatting the editor cannot keep ends live editing for that document
  (pages reload and open it comment-only) instead of dropping that content.
- **Secret values.** An edit that would put one of the document agent's secret
  values into the text is refused before anyone else receives it
  ([`edit_refused`](../help/errors/edit-refused.md)); the page reloads from
  the server's copy and says why. In a design, an edit that breaks the board
  format or makes a board larger than 512 KB is refused the same way.
- **When live editing is not used.** Documents with formatting the editor
  cannot keep (images, checklists, HTML) open comment-only, as before, and
  never go live. When the page cannot join (no WebSocket through a proxy,
  [`live_unavailable`](../help/errors/live-unavailable.md)), it saves
  versions the usual way: each save names the version it started from and is
  refused with `document_version_conflict` if someone published since.
- **Several copies of the control plane.** Each document is served by one
  copy at a time (the others hand its connections to it), or, with
  `WARDBY_LIVE_REDIS_URL`, by every copy through Redis. See
  [Availability](availability.md#why-the-control-plane-can-run-more-than-one-copy).
- **History.** The live copy is kept in PostgreSQL and continues across
  restarts. A page holding a copy from a history the server no longer has
  (the live copy was reset) is refused
  ([`live_state_stale`](../help/errors/live-state-stale.md)) and reloads, so
  an old copy is never merged back in.

## Edits and restore

The side panel of a document page has the same tabs as a design page's:
**Comments**, **Review** and **History**. The History tab lists every version, newest first, with who made it, how and
when:

- Saves from the browser editor by the same person, each within 5 minutes of
  the one before, share one row ("v4–v5 · Name · 2 edits"); two people with the
  same display name never share a row. Versions from an
  agent, from MCP (marked "(MCP)"), restores and reopens always have their own row.
- An agent's version reads "Agent · via <the person who sent the threads>"
  with a "for thread #N" link that opens that thread in the Comments tray.
- A restore reads "Restored v3 · Name".
- A reopen for review reads "Reopened for review from v3 · Name": its version
  is a copy of the approved v3, which keeps its own row.

Click a row to see that version read-only, with what it changed against the
version before the row: added text highlighted, removed text struck through
where it was. Changes are compared word by word on the document's text, so a
new heading or list item shows as added text and formatting-only changes are
not marked. Comment highlights are hidden while you look at an earlier
version; **Back to latest** (or Esc) returns to the editor. New versions keep
arriving in the list while you look.

**Restore this version** (members with `write`) publishes that version's
Markdown as a new version with the summary "Restored v<N>"; nothing is
deleted, so a restore can itself be undone by restoring again. It goes through
the same checks as any publish (size limit, redaction, comment re-anchoring),
and is refused with `document_version_conflict` if someone published after the
newest version your page shows, and with `document_version_is_latest` when you
pick the version that already is the newest (nothing would change). Documents the editor opens comment-only
(images, checklists or HTML) can still be restored, because the stored
Markdown is copied as it is. Readers and share-link guests see the tray and
the changes, but not Restore.

Over MCP, `list_document_versions` pages with `before` and `limit` (default
50, at most 200; pass the returned `nextBefore` for older ones) and returns no
content; read a version with `get_document` and `versionNumber`.
`restore_document_version` takes `versionNumber` and a required `baseNumber`
(the latest version you saw) for the same conflict check. Only a restore may
write a summary reading "Restored v<N>": `publish_version` refuses such a
summary with `document_summary_invalid`.

`publish_version` also takes a required `baseNumber`: the version number you
read (`get_document` returns it). It is refused with
`document_version_conflict` when a newer version was published since; read
the document again and redo the change on the new version.

**Upgrading.** `publish_version` now requires `baseNumber`. A client that
calls it without one gets an error naming the field: read the document first
and pass the version number it returns.

The page API behind the tray: `GET /d/api/<documentId>/versions?before=&limit=`,
`GET /d/api/<documentId>/versions/<n>` and `POST /d/api/<documentId>/versions/<n>/restore`
with `{"baseNumber": <n>}` (CSRF and `Origin` as for every change).

## Review states

A whole document or design has a review state, separate from its comment
threads: **draft** (the default), **in review**, **changes requested**,
**approved**, **rejected** (plan documents only) and **archived**. The owner submits it for review (`submit_for_review`,
or **Start review** on the page's Review tab) and names the reviewers: members
with access to the document, or guests of this document's live comment share
links who gave a name. Naming a member gives them comment access if they lack
it. For a reviewer with no access, the page's reviewer picker offers **Create
comment link**: the link is shown once, and once the reviewer opens it and
gives a name, **Refresh list** shows them. The owner may also name one final
approver. Reviewers act only with live access (comment access for a
member, an unrevoked and unexpired comment link for a guest).

The state is computed from the verdicts on the **current version** only: a force
approval gives approved; otherwise any current changes-requested verdict gives
changes requested; otherwise every reviewer's current approval gives approved;
otherwise in review. Publishing a new version while the document is in review or
has changes requested recomputes it, so earlier verdicts stop counting. A
reviewer's verdict names the version they read (`review_document` takes
`versionNumber`); if a newer version was published first it is refused with
`document_version_conflict`, and the page offers **Review vN** to see what
changed. A reviewer is offered only the verdict they have not already given on
the current version (on a document every reviewer approved, only **Request
changes on vN**; on a force approval, nothing); repeating a verdict changes
nothing and records no event.

- **Force approve**: the owner or the final approver approves the current
  version over missing verdicts and requested changes. A note is required and
  the history lists who was overridden. It is only possible in review or with
  changes requested.
- **Reject** (documents of a plan only): the owner, the final approver or a
  named member reviewer rejects a document the plan does not need, such as a
  design option that was not chosen (`reject_document`, or **Reject** on the
  Review tab). A note is required. It works in review, with changes requested
  or approved. The document becomes rejected: locked like an approved one, and
  out of the plan, so it no longer counts toward the plan's approval and a
  builder never gets it; rejecting the last document the plan waited for
  approves the plan. A plan's own `plan.md`, a document outside a plan, and a
  document already out of the plan are refused with
  `document_reject_not_plan_document`. Guests cannot reject.
- **Choose this option** (alternatives in a plan): on the chosen option's
  Review tab, **Choose this option** lists the plan's other undecided or
  approved documents, ticking those named like it (`option-b/` beside
  `option-a/`) and leaving the rest (shared screens) unticked. Confirming
  approves the chosen option as the viewer's verdict (a named reviewer; an
  approved option is left as it is) and rejects each ticked document with the
  note "Chose option-a/" (plus an optional note), in one transaction: if any
  part is refused, nothing changes. `choose_plan_option` does the same over MCP.
  The plan rail's **Pick an option** starts the same step from any page of the
  plan: it offers the alternatives (documents of one name family, not shared
  parts such as `screens/`) and, after confirming, says under the bar what it
  rejected and what the plan still waits for. The Review tab shows a next-step card (the one main button for the
  state: review, choose, or nothing once approved) and, below it, the other
  actions under Plan and Manage. Each of those (choose, reject, force approve,
  reviewers, reopen, archive) is a confirm step that has the Review tab to
  itself until it is confirmed or cancelled.
- **Reopen**: a writer reopens an approved or rejected document. Reopen for
  review creates a new version (a copy of the current one) and puts it in
  review, and a rejected document goes back into its plan; the earlier version
  stays in History as the record. Every reviewer then reviews
  the new version. A named reviewer can
  also request changes on a document every reviewer approved, which moves it to
  changes requested and unlocks it. A force approval is final: reviewers cannot
  change it (`review_document` is refused with `document_review_state_invalid`),
  and a writer reopens it for review.
- **Archive**: the owner archives and unarchives; unarchive returns the state it
  had before.
- **The lock**: an approved, rejected or archived document takes no new version by any
  route (editor, board saves, `publish_version`, restore, agent edits), and its
  threads cannot be sent to an agent: all are refused with `document_locked`. A
  document its planner removed from the plan is read-only to agents too: its
  threads cannot be sent to an agent (`document_locked`) until a later revision
  of the plan writes its file again. Comments stay open. A page open when the
  lock lands turns read-only in place, with no reload; edits not yet saved are
  kept ("Read only: approved · unsaved changes"). After a reopen they show as
  "Unsaved changes" and are saved with the next edit, never on a timer; a
  Markdown page is editable again in place, and a design page that was opened
  read-only must be reloaded to edit. An agent edit that finishes after the lock
  is not applied; each thread gets a reply naming the branch with the edit.

Open pages update live (the `review` event). The top bar shows the state and
approval count beside the title (it opens the Review tab), and a **Review** tab with reviewers, verdicts, history
and the actions you may take. The desktop Viewer's Documents tab shows the state
as a chip. An agent session can wait for approval with `wait_for_review`: create
the document, submit it, send reviewers a comment link if they have no account,
wait, revise on `changes_requested`, continue on `approved`. The wait also
returns when someone else comments (`reason: "comment"`); many MCP clients time
out a request after 60 seconds, so pass `timeoutSeconds` of 50 or less and call
again. Errors:
`document_locked` (409), `document_review_forbidden` (403),
`document_review_state_invalid` (409), `document_reject_not_plan_document` (409)
and `document_version_conflict` (409). See
[Review and approve documents](../help/document-review.md) for the details and
the per-code help articles.

## Designs

A design is a set of **boards**: one HTML file per screen, described by a
`manifest.json`, with an optional `brand.md` (up to 64 KB of notes agents may
read). Every change is a new version, as for Markdown, and a design can be
shared, commented on and exported like a document. Its `kind` is `design`
(`list_documents` and `get_document` report it).

Create one with `create_document` and `kind: "design"`, passing `files` (a map
of path to text) or, for a design that lives in a repository, a coding
`agentId`, `repository`, `path` (the directory holding `manifest.json`; `.` for
the repository root) and `baseRef`, with no `files`: Wardby reads the design
from that directory at that branch. A document or design can only be linked to a
repository its agent is already authorized for (`document_repo_link_invalid`
otherwise). Publish changes with `publish_version` and a full `files` map.
The full file set travels in one MCP request, which is capped at 1 MiB, so a
design over about 1 MiB cannot be updated over MCP: change it in the browser
editor, or send its comment threads to the design's agent. Importing from a
repository only creates a design; it does not update one.
`get_document` returns each file as a `--- <path> ---` section of
`documentText`, with `kind`, the file sizes and any `warnings`. A request that
does not fit the document's kind (Markdown for a design, files for a document)
is refused with `document_format_mismatch`.

Creating or publishing normalises the files: the manifest is rewritten in a
fixed layout and each board is sanitised (see [Security](#security)). Anything
that does not follow the format is refused with `board_format_invalid`, whose
message names the board and the kind of problem and never the offending text or
URL. Things removed without refusing (scripts, event handlers, `javascript:`
links, unsupported elements) are listed as warnings on the version.

### Board format v1

The files an agent or a person supplies must follow seven rules: the
`manifest.json` shape and board ids, no JavaScript, all CSS in the file with no
external resources, responsive layout, `#board:<id>` links between boards, CSS
variables on `body`, and a size budget per board. The exact rules, a manifest
example and a copy-ready agent skill are in the help article
`design-boards-format` ([source](../help/design-boards-format.md); read it with
`get_help_article`). Send-to-agent puts the same rules in the task, so a coding
agent follows them without extra setup.

### Editing designs

The design page edits the current version in a visual editor (GrapesJS, bundled
with Wardby, no CDN). Everyone sees the boards as tabs above the canvas (wrapping
to two lines, then "+N more" with a filter; the current board's tab always
shows), the canvas, the Desktop, Tablet and Phone widths (on the row under the
top bar) for checking the responsive layout, and the **Comments** and
**History** tabs. People with `write` access also get:

- Board actions (**+** to add; rename, move up and down, delete in each tab's ⋯
  menu) and a **Layers** tree at the bottom of the left panel, closed until
  opened (remembered in the browser).
- **Style** and **Settings** tabs (right) for the selected element, with Undo
  and Redo.

Everyone with the design open sees it live, and people with `write` edit it together (see [Live editing](#live-editing)):

- **Boards go live when opened.** The first person to open a board builds its
  live copy from the version's file, and everyone else on that board joins it
  (a page with only `comment` or `read` access waits for someone who can
  edit). Until the board's live copy reaches a page, the board cannot be
  edited there. A board nobody has opened stays as the version's file.
- **Element by element.** Changes reach the others as they are made, text as
  it is typed, without reloading the canvas. Two people changing different
  properties of one element both keep their change, and two people typing in
  the same text box both keep every character (what someone else types in a
  box you are typing in appears when you leave the box; characters two people
  type at the very same spot at the same moment can interleave). If two people
  move the same element at the same moment, the later move stays.
- **Who is where.** Other people's selected elements are outlined in their
  colour with their name ("is typing" while they type in a text box), and each
  board's tab shows a dot for everyone on it. The board list (adding,
  renaming, moving and deleting boards) is shared too.
- **Undo** and **Redo** undo your own changes only, never someone else's.
- **Versions.** The server saves the whole file set as a version, as for
  documents. The page itself saves nothing while live.
- **Checks on every edit.** An edit that breaks the [board format](../help/design-boards-format.md)
  (for example a script or an external image), makes a board larger than
  512 KB, or would show one of the design agent's secret values is refused
  before anyone else receives it
  ([`edit_refused`](../help/errors/edit-refused.md)); the page reloads from
  the server's copy and says why.
- **Agents and `publish_version`.** A published version is merged into the
  live boards element by element, from the version it was based on, so
  people's edits made meanwhile stay; text an agent rewords in a text box
  someone else changed merges word by word (where both changed the same words,
  the published version wins). A board nobody has opened takes the published
  file. A publish based on an older version is merged the same way; when both
  it and a later version changed a board nobody has opened, it is refused
  with `document_version_conflict` (read the latest version and publish
  again).

When the page cannot join live editing (for example no WebSocket through a
proxy), edits save by themselves a moment after you stop, as a new version
that contains only the changed files. If someone else published first, the
page says so and offers to reload rather than overwriting. An edit that would
break the board format (for example an external image) is not saved, and the
page shows the problem.

A board's CSS as written is kept as a **base layer** that always renders as
written; the editor's own changes are saved as a separate block on top. When a
writer opens a version and the page saves the usual way (not live), the page
renders each board as written and in the editor and compares computed styles.
Where they differ it lists "N styles may not be editable on board X" under
**Checks**: the board still looks right, but those styles live only in the
base layer, so the Style panel cannot change them. To change them, edit the
HTML and CSS in the repository or send a comment to a coding agent. (The
comparison switches through every board, so it is not run while editing
live.)

### Comments on boards

Comment threads on a design are **pins**. Press `C` (or use the Comment
button), click an element in the canvas and write the comment; Esc leaves
comment mode. A pin is anchored to the element (its board, its id when it has
one, its tag, its first words and its path), plus the point you clicked as a
fraction of the element's box, so it stays on the element at every device
width. While the design is edited live, a pin also follows its element through
everyone's edits and agents' versions (it is kept on the element itself, not
on its place in the board), and is marked outdated when the element is
deleted. Open threads show as numbered pins; a resolved or outdated thread shows
its pin only while it is selected. When a new version no longer contains the
element, the thread is marked outdated, as for Markdown text. Replies,
mentions, resolve and reopen, live updates and share-link guests work as for
documents, and the Comments tab is the same list.

### Overview and Play

**Overview** shows every board at once as a scaled tile; picking a tile opens
that board in the editor. **Play** shows the design as a prototype, one board at
a time at Desktop, Tablet or Phone width: `#board:<id>` links move between
boards, Back steps back and Exit closes it. Both render boards in sandboxed
frames that cannot run script (see [Security](#security)), for every viewer
including share-link readers.

### Design version history

The **History** tab lists versions as the History tab does for documents. Click a
version to see its boards read-only in a layer over the canvas (the editor
cannot be reached while it is open, and comments pause); **Restore this
version** (members with `write`) publishes its files as a new version, with the
same `document_version_conflict` and `document_version_is_latest` checks as for
documents. Over MCP use `list_document_versions` and `restore_document_version`.

## Names and privacy

Members appear under the display name the identity provider gives
(the `name` or `preferred_username` claim), then their linked GitHub login, then a short tail of
their subject. Guests pick a name (1-40 characters, not containing "agent" or
"via", not the name of the document's owner or a member granted access to it,
compared case-insensitively after Unicode normalisation; two guests may share a
name, and each is shown with "(guest)"). Names are always HTML-escaped when shown. A
guest's optional email is stored but never shown on the page. Agent replies are
labelled as the agent.

## Share links and guests

`create_share_link` returns `https://<your-host>/s/<token>` once; only a hash
is stored, so a lost link must be replaced. Over stdio, links use the origin of
`MCP_CANONICAL_URI` when it is set; without it the document and share tools
return the path only (`path`, or `pagePath` where `path` is the repository
file) with a note, so open it on the address that serves Wardby's pages. `permission` is `view` or `comment`;
`expiresInDays` is 1-90 (default 14). Guests can read the current version and
(with `comment`) start threads and reply, 30 an hour per guest; one link
accepts 20 guest registrations an hour. They can open the History tab and see
earlier versions and their changes, but cannot edit, restore, send to an agent
or share. Revoking a link signs its guests out at once;
expiring does the same on their next request.

Treat the URL as a bearer secret: anyone with it has the access, and guest
names prove nothing. Use short expiries, revoke when finished, and keep
sensitive material out of shared documents. Wardby does not rate-limit by
network address (it cannot know the real client address behind your load
balancer); put abuse controls for the `/s/` paths at your edge if the link is
public.

## Documents from native agents

A native agent whose owner sets `documentTools` gets built-in `doc_*` tools in
its runs: `doc_list`, `doc_get`, `doc_list_threads` and `doc_get_thread`, and at
`access: "write"` also `doc_create`, `doc_publish_version`,
`doc_reply_to_thread`, `doc_resolve_thread` and `doc_submit_for_review`. They run
in the control plane, never in the sandbox, and act as the agent, not as its
owner.

| Field             | Meaning                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `access`          | `read` (read tools only, and read at most on every document) or `write`.                                                |
| `reviewers`       | 1 to 50 people who can read the agent; default the owner. A document the agent submits goes to them.                    |
| `finalApproverId` | Optional person who may force an approval.                                                                              |
| `maxNewPerRun`    | New documents one run may create, 1 to 20; default 5 (`document_run_limit`). The count survives a resumed run.          |
| `plans`           | Up to 20 planner agents (with `planDocument`) whose plan documents the agent may read and comment on, never publish to. |

Set it with `update_agent` or `create_agent` on a native agent (`null` turns it
off; an invalid setting is refused with a 400 starting
`document_tools_invalid: ` and the reason, e.g. `document_tools_invalid: only native
agents take documentTools.`; schema-level violations such as an out-of-range
`maxNewPerRun`, an empty `reviewers` list or unknown fields are refused earlier as
`Invalid create_agent/update_agent arguments: …`). It is read again on every
call. It is owner-only and counts as an owner binding: an agent everyone can
write cannot have it, and an agent that has it cannot be opened to everyone
with write. On `create_agent` only the owner can be a reviewer; share the agent
and then add other reviewers with `update_agent`. `make_owner` between two
owners turns it off and removes the document grants others gave the agent,
except on documents the new owner owns (`documentGrantsRemoved`); adopting an
agent that had no owner keeps both.

**Upgrading: `doc_` tool names.** Names starting with `doc_` are reserved for
these tools: `create_tool` and `wardby tool create` refuse a new one, an import
skips one with a warning, and `attach_mcp_server` refuses a server whose exposed
tool names start with `doc_`. A tool created under such a name before the
upgrade keeps working and can still be attached, but if its name is one of the
nine built-in names and the agent has `documentTools`, every call to that name
goes to the built-in tool and yours is never reached. Create it again under
another name, attach that, and detach the old one before turning
`documentTools` on.

**What the agent can reach.** Never its owner's access. Only: a document linked
to it as writer (`doc_create`, or `create_document` or `link_document` with
`agentId` alone for a native agent with `access: "write"` that you can
execute), while the document's owner can still execute the agent; agent grants
at `read` or `comment`; and the plan documents of `plans` at `comment`, while
the agent's owner can still execute the planner. Anything else is
`document_not_found`.

**What it never does.** Approve, force-approve, reopen, archive, share, grant,
or start comment threads. It replies to and resolves threads, and submits for
review to the setting's reviewers, only on documents its owner owns
(`document_review_forbidden` otherwise). The documents it creates are its
owner's; an owner-less agent's write tools return `document_agent_unavailable`.

**Reviewer notes.** `doc_get` includes each reviewer's verdict, the version it
was given on and their note (`null` when none), and the latest review events
(kind, version, reviewer name, note; newest first, up to 10), so an agent can act
on a rejection that has only a note. Reviewers are named, never identified by id
or email. Notes are redacted by exact secret value when stored, and reach the
model as untrusted tool-result text.

**Limits.** `doc_get` refuses a document or design over 60,000 characters
(`document_too_large_for_agent`), the same cap as send to agent.
`doc_publish_version` requires `baseNumber`, the version the agent read; a newer
version means `document_version_conflict`. An approved or archived document is
locked (`document_locked`). Tool failures are JSON results with an `error` code.

**Send threads to agent.** On a document whose writer is a native agent, a send
starts a native run with the trigger `comment`. The agent reads the threads,
publishes one revision and replies; threads it leaves unanswered get the usual
no-reply note. There is no automatic merge. A send is `document_not_agent_linked`
when the agent has no `documentTools` setting, and `document_agent_unavailable`
when its setting is no longer `write` or the document's owner lost `execute`.

## Review routing

A **router** is a native agent that decides who works next when someone acts on a
document, a design or a set in review. Wardby starts it with a short description
of the action; it reads the documents and starts the agents that should do the
next piece of work, each with its own task, using its `delegate_to_*` tools
(attach them with `attach_subagent`). With no router in play, review actions
start nothing. The short guide is the help article
[Route work from reviews](../help/route-work-from-reviews.md).

| Setting or tool                             | Who                           | Meaning                                                                                                                                     |
| ------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `router` on `create_agent` / `update_agent` | Agent owner                   | The agent routes work. Native agents only; needs a `description` and `documentTools`. Refused with `review_router_invalid`.                 |
| `description`                               | Anyone who can edit the agent | What work the router takes; `request_work` ranks routers by it.                                                                             |
| `reviewRouter`                              | Agent owner                   | On a writer or planner: the router that gets reviews of its documents when no router started the work. A router the owner can run.          |
| `maxStartsPerDecision` (1 to 100)           | Agent owner                   | The most agents one person decision may start (default 20).                                                                                 |
| `link_document` `routerAgentId`             | Document owner                | Change or clear (`null`) the router of a document not in a set; a router the caller can run.                                                |
| `request_work`                              | Anyone with `runs:trigger`    | Without `router`, ranks up to 5 routers you can run by their descriptions and starts nothing; with `router`, starts it with your `request`. |

**Which router.** The router whose work produced the document, found up the run
tree when the document is created (router, then lead, then writer, at any
depth). Otherwise the writer's `reviewRouter`, read when the action happens.
A router is checked again when each action happens: it must still be
`router: true`, and a router the document's owner set with `link_document` must
still be one the owner can run, and a writer's `reviewRouter` one the writer's
owner can run (a router recorded from the run tree needs nothing more). A router
that fails the check is skipped, as if it were not set; when none is left,
nothing starts. Documents in a set route through the set and take no router of
their own (`link_document` refuses `routerAgentId` for them).

**Which actions.** Every review action: submitted, approved (and force
approved), option chosen, changes requested, rejected, reopened, archived,
unarchived and reviewers changed. In a set, the set entering review (its first
submit: a later member's submit routes nothing, and a published plan's documents
enter review together), the approval that completes the set, a choice (once,
not once per document) and each other action once. A plan approval routes only
for the action that completed it, and an approval completed without a review
action (for example removing the last waiting document) does not route. Each action routes once; a failure to
start the router never fails or undoes the person's action.

**Option sets.** A native writer can put documents in an option set with
`doc_create` `set` (a name) and `option` (a label). A person picks one with
**Choose this option** (or `choose_plan_option`); the choice is one action for
the router.

**The note.** `submit_for_review`, an approval, a choice and a request for
changes take an optional `note` (up to the review-note limit). It reaches the
router labelled as that person's, with secret values removed as for any review
note.

**The router's task.** Fixed text written by Wardby: the action, the documents
by id (and option labels), who acted, the note, and "The builder for this plan
was already started." when the plan's `onApproved` is `build`. It carries no
document content. The router and the agents it starts read those documents by id
with `doc_get` for the length of their run; the documents do not appear in
`doc_list`. A native agent it starts needs `documentTools` when the router was
given documents, else the start is refused with
`review_route_target_no_documents` (a `request_work` run has none, so any
attached agent may take it). A coding agent gets the documents as files in
`/tmp/wardby-plan` (a planner gets none), and documents too large for a coding
run refuse with `plan_too_large`. An agent owned by
someone else runs its own instructions, and the router's task text is dropped.

**Limits.** `maxStartsPerDecision` counts start attempts for one person decision
across every router run that agents' own actions set off. Each such router run
is itself one start, and so is a router run set off by a plan that a planner in
the work publishes. A start refused later (for example for budget) still
counts, and a gateway crash in the middle of a start can count it once more.
Past it a start is refused with `review_route_limit` (a router run past it is not
started); the person's next action starts a new count.
`maxDelegationsPerRun` still limits each run. The router run's budget covers the
agents it starts, and it can start only its attached agents that its owner can
run.

**Asking for work.** `request_work` lets a person describe work in plain words.
With `router` the router starts with the request as its task; `router: true`
means people who can run it may send requests. Assistants are told to start the
router when one clearly fits and to ask when several do. Documents the work
produces route back to it. A Jira project, repository, schedule or webhook can
be linked to a router like to any agent.

**Visibility.** `trigger_agent` on a writer with a `reviewRouter` adds
`reviewsGoTo` (only while it is `router: true` and you can run it).
`list_agent_links` adds `routes_reviews` links, and a router keeps a `manual`
entry point. The page's
Review tab has a **Routing** section: the router (or "No router: review actions
start nothing."), each action's outcome, the agents started (the 10 newest per
action) and the first line of their task, with secret values removed, and a
sentence when a start was refused (`route_failed`, `run_refused`, `run_failed`,
`review_router_invalid`, `review_route_limit`). On the tab, task text is shown
only to the document's owner and people who can run that router; the person who
started an action can still open its runs with `get_run`. An action whose
router run already started agents keeps showing them when a later start is
refused (the router gets the refusal as its tool result).

## Sending threads to a coding agent

Link a document to a repository file at creation (`create_document` with
`agentId`, `repository` and `path` together), or later with `link_document`. (A design links to a directory
instead; see [Sending design threads](#sending-design-threads).) The agent must be a coding
agent you own, or one whose owner set `codingProfile.allowWebhookTaskOverride`
and granted you `execute`: a send hands the agent task text, the same rule as
`trigger_agent`. `path` is a repository-relative `.md` file of plain segments
(letters, digits, `.`, `_`, `-`; at most 256 characters); `baseRef`, if given,
must be a valid branch name. The repository must be one the agent is already
authorized for (its coding repository, or one on its repository list that is
linked), so linking a document never widens what an agent can reach; otherwise
`create_document` answers `document_repo_link_invalid`, and a send re-checks it.
An `agentId` without a repository follows the same rule.

`link_document` takes the same `agentId`, `repository`, `path` and `baseRef` for
a document you own, and replaces its link; for a design it needs `baseRef`.
`unlink: true` clears the link. The content is not changed, and the next send
uses the new link. Only the owner may change a link (`document_access_denied`
for anyone else), and not while threads are with the agent: a run publishes
back through the link it started with, so a change then answers
`document_link_busy`.
Then a person with `write` access sends open threads (up to 50) from the page or
with `send_threads_to_agent`. Wardby starts one coding run (run trigger
`comment`) with the document, the threads and the file path; when it ends, the
file at the run's head ref becomes the next version if the document has not
changed meanwhile (see [When the document changed while the agent
worked](#when-the-document-changed-while-the-agent-worked)), and the agent
replies on each thread and resolves those it addressed.

Limits: 30 sends per document per hour, a document up to 60,000 characters,
one run per thread at a time. The document owner must keep `execute` on the
agent and remain allowed to give it task text (its owner, or the owner's
`allowWebhookTaskOverride`); every send checks this again. A native agent with `documentTools` can be the writer too; see [Documents from native agents](#documents-from-native-agents). Documents with
images, task lists or raw HTML open comment-only in the page, because the
editor would rewrite them.

The task text is also redacted at send time against the agent's current secret
values, so a value that became a secret after the version was published does not
reach the run.

Secret values of the linked agent are replaced in document titles, document
and comment text before they are stored, so a pasted secret does not become
document content. The file an agent run writes, and its replies, are also
checked for token-shaped values (provider keys, Git host tokens) before they are
published.

### Sending design threads

A design links to a repository **directory** holding `manifest.json` (`path`;
`.` for the root) and needs a `baseRef`, the branch the agent's run starts from.
Any coding agent works, Codex or Claude Code, with the same rules as for a
document. A send compares the design in Wardby with the directory at `baseRef`
and puts only the files that differ in the task (and lists files to delete);
board files already in the repository are not repeated. The whole task, with
the threads and the agent's own instructions, must fit the 64 KiB coding-task
limit, or the send is refused with `document_too_large_for_agent`. The threads
are pins, so each is described by its board, the element's tag, its first words
and its path. The task states the [board format](#board-format-v1) rules. When
the run ends, the design directory at the run's head ref becomes the next
version if the design has not changed meanwhile, with the same normalisation
and sanitising as any publish (a result that breaks the format counts as a
failed run: the threads get the failed reply and the design is not changed). If the design in the
repository cannot be read (a board missing or too large), the send fails with
`document_send_failed` and no thread changes.

### When the document changed while the agent worked

A newer version published while the run worked is never overwritten. Wardby
tries three things in order:

1. **A merge.** The agent's edit, the newer version and the version that was
   sent are compared file by file (a design's `manifest.json` and each board, a
   missing file meaning deleted; a Markdown document is one file). A file only
   one side changed takes that side's text; a file both changed the same way is
   kept. A file both changed is merged line by line when the two sides' changes
   neither overlap nor touch (adjacent lines count as touching): an edit to one
   paragraph and an edit to another both land, as do edits to two separate
   style rules of a board. Blank lines at the end of a file are set aside
   first, so adding or dropping one is never a conflict. Changes to the same or adjacent lines, or a file too
   different to compare line by line, make that file a conflict; no conflict
   markers are ever written. If no file conflicts, the merge is published
   through the normal publish path (normalising, sanitising and redaction; a
   merge those checks refuse counts as a conflict) with the summary
   `Agent edit for comment threads #2 (merged with v3)`, and the replies and
   resolving follow as for any send.
2. **One reconcile run.** Otherwise Wardby starts one more coding run, trigger
   `comment`, as the person who sent the threads, on the latest version, for
   the threads still open or outdated (a thread closed meanwhile is left out and
   gets no reply). Its task holds the current content (built as for a send) and
   the agent's earlier edit (a design's changed files, or the whole edited
   Markdown; when those and the current content together do not fit the
   coding-task limit, a unified diff of each changed file against the version
   that was sent instead), all redacted against the agent's current secret values and
   wrapped as untrusted content, and asks the agent to re-apply its change on
   top of the current version and reply on the threads. Every check a send makes is made again: the sender's
   `write` access, the owner's `execute` on the agent, the agent's link and
   authorisation for the repository, the hourly send limit and the task size.
   Each thread first gets the agent note "The document changed while the agent
   worked, so it is re-applying its edit on version N." The reconcile run is a
   fresh run for every coding agent kind, not a resumed session; its result is
   published like a send's, merge included.
3. **The conflict note.** If the edit is too large to send back even as a diff,
   each thread gets "The document changed after this was sent, and the agent's
   edit is too large to re-apply automatically, so it was not applied. It is on
   branch …". If a reconcile run cannot start for another reason, or a reconcile run's
   own edit conflicts and cannot be merged, each thread gets "The document
   changed after this was sent, so the agent's edit was not applied. It is on
   branch …" and stays open. If the reconcile run itself fails, times out or is
   refused, each thread gets "The agent run that re-applied the edit on the
   newer version failed, so the document was not changed. The earlier edit is
   on branch …", naming the first run's branch, and stays open. There is at
   most one reconcile run per send; a person can send the threads again.

## Exports

| Format       | For                  | Result                                                               | Needs the renderer |
| ------------ | -------------------- | -------------------------------------------------------------------- | ------------------ |
| `board-html` | a design             | One board's HTML file (`board` required)                             | no                 |
| `prototype`  | a design             | One HTML file with a board switcher and working links between boards | no                 |
| `png`        | a design             | One board as an image (`board` required)                             | yes                |
| `pdf`        | a design or Markdown | All boards of a design, or a paginated A4 PDF of a Markdown document | yes                |

A Markdown document exports as PDF only (`export_format_unsupported` otherwise).
Both kinds have an Export menu on the page, and a document page has **Export
PDF**. An export covers the current version, or the one you ask for
(`versionNumber`). A Markdown PDF leaves out images that are not embedded as
`data:` URLs.

Page API: `GET /d/api/<id>/export?format=board-html|prototype&board=&version=`
(share-readable) and, for PNG and PDF, `POST /d/api/<id>/exports` with
`{ format, board?, versionNumber? }` (answers 202 with `exportId`), then
`GET /d/api/exports/<exportId>` for the status and `.../file` for the bytes.
Over MCP, `export_document` does the same and waits up to 150 seconds for PNG
and PDF (image and embedded-resource results); HTML comes back as `fileText`,
wrapped as untrusted tool output. A PNG or PDF export still running after 150
seconds (for example while the renderer wakes on a cold node) returns
`{ "exportId": "...", "status": "running" }` instead; call `export_document`
again with the same arguments plus `exportId` to keep waiting for that export
without starting another.

HTML files carry no script except the prototype's switcher, which the file's
own Content-Security-Policy allows by hash; boards sit in sandboxed frames (see
[Security](#security)). A rendered export is kept for one hour and can be read
only by whoever asked for it. Anonymous share-link readers can download HTML
exports but need to sign in or register as a guest to ask for PNG or PDF
(`export_sign_in_required`). The stored content was redacted against the linked
agent's secret values when it was written, so exports hold none.

### The renderer

PNG and PDF need the server's renderer; without one the request is refused with
`export_renderer_unavailable` (HTTP 503) and nothing is queued. The renderer is
an optional service (headless Chromium, no egress, no database or secrets) that
the control plane calls over HTTP.

| Variable              | Default             | Meaning                                                                                                                      |
| --------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `WARDBY_RENDERER_URL` | unset (no renderer) | Base URL of the renderer, `http(s)://host:port` with no credentials, query or fragment. Unset turns PNG and PDF exports off. |
| `RENDERER_DEPLOYMENT` | `wardby-renderer`   | The Kubernetes Deployment low-power mode scales for the renderer.                                                            |
| `PORT`                | `8796`              | On the renderer service itself (not the control plane): the port it listens on.                                              |

Where to turn it on:

- **GKE:** set `WARDBY_RENDERER=true` for `deploy/gke/up.sh`; it builds the
  image, applies the manifests and sets `WARDBY_RENDERER_URL`
  ([renderer](../deploy/gke/README.md#pngpdf-export-renderer-optional)).
- **EKS:** the Terraform module creates the image repository; build, apply and
  configure as in [the AWS module](../deploy/aws/README.md#pngpdf-export-renderer-optional).
- **Local:** build the image (`npm run renderer:image:local`), then
  `docker compose -f deploy/local/docker-compose.renderer.yml up -d` and start
  the control plane with `WARDBY_RENDERER_URL=http://127.0.0.1:8796`.

On Kubernetes the pod asks for 500m CPU and 2 GiB of memory (the most it needs
while buffering several renders at once), with a health check that restarts it
if Chromium crashes or renders get stuck. In low-power mode it sleeps when no
export was requested in the idle window; the first export after that waits for
it to wake (about 20 seconds normally, but a cold node can take minutes, and the
wait gives up after 5 minutes with `export_renderer_unavailable`; retrying
usually works). `power_sleep` accepts `target: "renderer"`.

## Viewer: Documents

The desktop viewer (`apps/viewer`) has a **Documents** tab that lists the
documents and designs the signed-in person owns or was granted, from
`GET /admin/api/documents` (see [the viewer API](viewer-api.md#get-adminapidocuments)).
Like the rest of the viewer it needs the `admin:view` scope and the `admin`
role, so the tab is for administrators; it does not show documents the person
merely could open as an administrator. It loads the newest 500 and filters them
in the app by agent, repository and title, so an older document that does not
show up is past that window (other clients can pass the API's `agent` and
`repository` parameters). Opening a row sends the browser to
`https://<your-host>/d/<id>`; the viewer only opens `https` links, so a server on
plain `http` cannot be opened from the viewer (copy the address instead). Each
row shows the document's review state as a chip.

## Limits

| Limit                        | Value                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| Markdown per version         | 1 MiB (UTF-8 bytes)                                                                                       |
| Design per version           | 2 MiB in all (`document_too_large`)                                                                       |
| One board                    | 40 KB recommended (a warning), 512 KB hard (`board_too_large`)                                            |
| Boards per design            | 50                                                                                                        |
| `brand.md`                   | 64 KB                                                                                                     |
| MCP request body             | 1 MiB (`publish_version` sends every file: update a larger design in the editor; see [Designs](#designs)) |
| Comment or reply             | 10,000 characters                                                                                         |
| Quoted anchor text           | 10,000 characters                                                                                         |
| Guest name                   | 1-40 characters                                                                                           |
| Share link lifetime          | 1-90 days, default 14                                                                                     |
| Threads per send             | 50                                                                                                        |
| Sends per document           | 30 an hour                                                                                                |
| PNG/PDF exports per document | 30 an hour, each at most 20 MiB                                                                           |
| Guest comments and replies   | 30 an hour per guest                                                                                      |
| Guest registrations per link | 20 an hour                                                                                                |
| Document sent to an agent    | 60,000 characters (a design: the 64 KiB coding task)                                                      |
| Mentions checked per comment | 20 (members and guests)                                                                                   |
| Live-update streams          | 5 per browser session on each server replica                                                              |

## Security

Document pages are served by the control plane with a strict
Content-Security-Policy (`default-src 'none'`; scripts only from the same
origin or a per-request nonce, no framing), `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and
`Cache-Control: no-store`. A Markdown page allows no inline styles. A **design
page** also allows inline `<style>` (`style-src 'self' 'unsafe-inline'`) and
`data:` fonts (`font-src 'self' data:`): the editor renders each board's CSS in
`<style>` elements inside its canvas and inlines its icon font, and the canvas
inherits the page policy. Scripts still cannot run there: there is no
`unsafe-eval`, no inline script, and board HTML is sanitised before it is
stored. The editor bundle ships with Wardby and loads from the same origin, with
no CDN, and its script tags carry Subresource Integrity (sha384) hashes; the
editor's telemetry is switched off. Changing requests need a matching `Origin`
and a per-session CSRF header. Session cookies are `__Host-` prefixed, HttpOnly
and Secure on HTTPS. Share tokens are in the URL path, so keep that path out of
any proxy log you cannot protect.

Review notes are redacted against the linked agent's secret values before they are stored, and returned to MCP as untrusted text. Review events carry ids, states, version numbers and notes only.

**Board sanitiser.** Every board is parsed and sanitised on every write (create,
publish, editor save, restore, and a coding agent's result), so a stored board
is never trusted markup:

- Removed (and counted as a warning): `<script>`, `on*` attributes,
  `javascript:` and `vbscript:` URLs, forms and inputs, frames, `object`,
  `embed`, media elements, `<link>`, `<meta>`, `<base>`, `srcset`,
  SMIL animation, `foreignObject`, and the editor's `data-gjs-*` attributes.
- Refused with `board_format_invalid`: any external reference, that is a
  stylesheet, image, font or `url()`/`@import` that is not a `data:` image or a
  `#fragment` (links to `https://` pages are fine), script-like CSS
  (`expression()`, `behavior`), malformed CSS, a bad manifest, and files that
  the manifest does not list.

**Frames.** Boards are shown in `srcdoc` frames, never as page markup. Overview
and the version-history view use an empty `sandbox` (no script, no same-origin,
no navigation). Play uses `sandbox="allow-top-navigation-by-user-activation"`,
which only lets a board link change the page's fragment. The downloaded
prototype file adds `allow-same-origin` (so its switcher can set the frame) but
never `allow-scripts`; the file's own policy allows only its switcher script, by
hash. There is no separate content origin for boards yet.

**Renderer isolation.** The renderer runs Chromium with Chromium's own sandbox
off, because the container runtime's default seccomp profile blocks the user
namespaces it needs. The pod is therefore the boundary: gVisor (GKE sandbox
nodes, or the EKS gVisor node group), a non-root user, a read-only root
filesystem, all capabilities dropped, no service-account token, no database or
secrets, and a NetworkPolicy that admits only the control plane and lets the
renderer reach nothing. On local Docker and kind (runc) only the container
settings apply, so do not expose a local renderer beyond localhost. PNG and PDF
exports require a signed-in member or a registered guest; the renderer is never
reachable from the browser.

## Troubleshooting

Each error code has an article under `help/errors/`: `document_not_found`,
`document_access_denied`, `document_too_large`, `document_kind_unsupported`,
`document_version_conflict`, `document_version_is_latest`, `document_summary_invalid`, `document_version_not_found`, `document_not_agent_linked`,
`document_agent_unavailable`, `document_repo_link_invalid`,
`document_send_failed`, `document_send_not_available`,
`document_too_large_for_agent`, `document_format_mismatch`,
`document_reject_not_plan_document`, `board_format_invalid`, `board_too_large`, `comment_anchor_invalid`, `comment_too_long`,
`comment_thread_closed`, `comment_thread_already_sent`,
`comment_send_rate_limited`, `comment_not_found`, `comment_edit_forbidden`,
`guest_name_invalid`, `guest_email_invalid`, `share_link_invalid`,
`share_link_not_found`, `share_expiry_invalid`, `share_permission_invalid`,
`export_format_unsupported`, `export_sign_in_required`, `export_not_found`,
`export_rate_limited`, `export_too_large`, `export_renderer_unavailable`,
`export_failed`,
`web_login_failed`, `web_login_state_invalid`, `web_login_not_configured`,
`web_csrf_failed`, `web_origin_rejected`, `web_session_required`,
`web_rate_limited` and `web_assets_missing` (the bundle was not built: run
`npm run build`). For what an error response from the page API looks like
(including the `id` of a 500 to look up in the log), see
`help/errors/web-request-errors.md`. In the MCP tools, the help articles are found with
`search_help`.
