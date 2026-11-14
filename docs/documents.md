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
- Select text to start a comment thread; threads anchor to the quoted text and
  follow it across versions. If the text is deleted, the thread is marked
  outdated; it still takes replies.
- Replies, resolve and reopen, edit and delete your own comments, and
  `@`-mentions (stored and highlighted; Wardby sends no notification in this
  phase). Members can mention members and the guests who have commented on
  the document (shown as "Name (guest)"); share-link guests get no list of
  people to mention.
- Live updates: new comments, replies, resolved threads and new versions show
  up on every open page without a refresh.
- An Edits tray: every version, who made it and how, the changes each one
  made shown inline, and restore (see [Edits and restore](#edits-and-restore)).
- Links to share a document with people who have no account.
- Send open threads to a coding agent that edits a file (or, for a design, a
  directory) in a repository.
- Export a design as HTML, PNG or PDF and a Markdown document as PDF.

## Tools

| Tool                                                         | Scope             | Purpose                                                                                         |
| ------------------------------------------------------------ | ----------------- | ----------------------------------------------------------------------------------------------- |
| `create_document`                                            | `documents:write` | Create a document or a design (`kind`); optionally link it to a repository and coding agent     |
| `link_document`                                              | `documents:write` | Link a document you own to a repository and coding agent, or change or clear the link           |
| `publish_version`                                            | `documents:write` | Publish the next version: `markdown` or, for a design, `files` (needs `write`)                  |
| `get_document`                                               | `documents:read`  | Read the current or a numbered version (`versionNumber`)                                        |
| `list_document_versions`                                     | `documents:read`  | List versions, newest first: who, how, when, the run and threads it answered                    |
| `restore_document_version`                                   | `documents:write` | Publish an earlier version's content as a new version (needs `write`)                           |
| `list_documents`                                             | `documents:read`  | Documents you own or were granted (200 newest; `truncated` past that)                           |
| `list_comment_threads`, `get_comment_thread`                 | `documents:read`  | Read threads (`open`, `resolved`, `sent`, `mine`, `all`)                                        |
| `reply_to_thread`, `resolve_thread`                          | `documents:write` | Reply (needs `comment`), resolve                                                                |
| `create_share_link`, `list_share_links`, `revoke_share_link` | write / read      | Manage share links (owner only)                                                                 |
| `send_threads_to_agent`                                      | `documents:write` | Start a coding run from threads; also needs `runs:trigger`                                      |
| `submit_for_review`                                          | `documents:write` | Submit a document you own for review, or replace its reviewers (`reviewers`, `finalApproverId`) |
| `review_document`                                            | `documents:write` | Give a verdict as a named reviewer (`approve` or `request_changes`, on `versionNumber`)         |
| `force_approve_document`                                     | `documents:write` | Owner or final approver approves the current version over missing verdicts (`note` required)    |
| `reopen_document`                                            | `documents:write` | Reopen an approved document for review (needs `write`)                                          |
| `archive_document`                                           | `documents:write` | Archive or unarchive a document you own                                                         |
| `wait_for_review`                                            | `documents:read`  | Wait for a state change, a comment by someone else, or a timeout (default 300 s, max 600 s)     |
| `export_document`                                            | `documents:read`  | Export a design (board HTML, prototype HTML, PNG, PDF) or a document as PDF                     |

Text people wrote (titles, Markdown, comment bodies, names) comes back wrapped
as untrusted content: agents must treat it as data, never as instructions.

## Access

Documents are a `grant_access` resource type (`resourceType: "document"`).
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

At the provider, register a web client with the redirect URI
`https://<your-host>/web/callback` (the origin of `MCP_CANONICAL_URI`), and make
sure its ID tokens carry the same `sub` as the access tokens MCP clients get, so
both sign-ins are the same Wardby person. The issuer is the existing
`AUTH_ISSUER`. A sign-in must finish within 10 minutes in the browser that
started it. A browser session ends after 12 hours idle or 7 days. Without
`WEB_OIDC_CLIENT_ID`, member pages answer `web_login_not_configured`; share
links keep working. With `AUTH_PROVIDER=self-hosted`, the `WEB_OIDC_*`
variables are ignored.

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

## Edits and restore

The side panel of a document page has two tabs: **Comments** and **Edits**.
The Edits tray lists every version, newest first, with who made it, how and
when:

- Saves from the browser editor by the same person, each within 5 minutes of
  the one before, share one row ("v4–v5 · Name · 2 edits"); two people with the
  same display name never share a row. Versions from an
  agent, from MCP (marked "(MCP)") and restores always have their own row.
- An agent's version reads "Agent · via <the person who sent the threads>"
  with a "for thread #N" link that opens that thread in the Comments tray.
- A restore reads "Restored v3 · Name".

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

The page API behind the tray: `GET /d/api/<documentId>/versions?before=&limit=`,
`GET /d/api/<documentId>/versions/<n>` and `POST /d/api/<documentId>/versions/<n>/restore`
with `{"baseNumber": <n>}` (CSRF and `Origin` as for every change).

## Review states

A whole document or design has a review state, separate from its comment
threads: **draft** (the default), **in review**, **changes requested**,
**approved** and **archived**. The owner submits it for review (`submit_for_review`,
or **Submit for review** on the page) and names the reviewers: members, or
guests of this document's live comment share links who gave a name. Naming a
member gives them comment access if they lack it. The owner may also name one
final approver. Reviewers act only with live access (comment access for a
member, an unrevoked and unexpired comment link for a guest).

The state is computed from the verdicts on the **current version** only: a
force approval gives approved; otherwise any current changes-requested verdict
gives changes requested; otherwise every reviewer's current approval gives
approved; otherwise in review. Publishing a new version while the document is
in review or has changes requested recomputes it, so earlier verdicts stop
counting. A reviewer's verdict names the version they read
(`review_document` takes `versionNumber`); if a newer version was published
first it is refused with `document_version_conflict`, and the page offers
**Review vN** to see what changed. A reviewer is offered only the verdict they
have not already given on the current version (on an approved document, only
**Request changes on vN**); repeating a verdict changes nothing and records no
event.

- **Force approve**: the owner or the final approver approves the current
  version over missing verdicts and requested changes. A note is required and
  the history lists who was overridden. It is only possible in review or with
  changes requested.
- **Reopen**: a writer reopens an approved document (back to in review). Every
  reviewer then reviews again, even for the same version. A named reviewer can
  also request changes on an approved document, which moves it to changes
  requested and unlocks it.
- **Archive**: the owner archives and unarchives; unarchive returns the state it
  had before.
- **The lock**: an approved or archived document takes no new version by any
  route (editor, board saves, `publish_version`, restore, agent edits), and its
  threads cannot be sent to an agent: all are refused with `document_locked`.
  Comments stay open. A page open when the lock lands turns read-only in place,
  with no reload; edits not yet saved are kept ("Read only: approved · unsaved
  changes"). After a reopen they show as "Unsaved changes" and are saved with
  the next edit, never on a timer; a Markdown page
  is editable again in place, and a design page that was opened read-only must
  be reloaded to edit.
  An agent edit that finishes after the lock is not applied; each thread gets a
  reply naming the branch with the edit.

Open pages update live (the `review` event). The page shows a banner with the
state and approval count and a **Review** tab with reviewers, verdicts, history
and the actions you may take. The desktop Viewer's Documents tab shows the state
as a chip. An agent session can wait for approval with `wait_for_review`: create
the document, submit it, send reviewers a comment link if they have no account,
wait, revise on `changes_requested`, continue on `approved`. The wait also
returns when someone else comments (`reason: "comment"`); many MCP clients time
out a request after 60 seconds, so pass `timeoutSeconds` of 50 or less and call
again. Errors:
`document_locked` (409), `document_review_forbidden` (403),
`document_review_state_invalid` (409) and `document_version_conflict` (409). See
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
with Wardby, no CDN). Everyone sees the **Boards** list (left), the canvas, the
Desktop, Tablet and Phone widths for checking the responsive layout, and the
**Comments** and **History** tabs. People with `write` access also get:

- Board actions (add, rename, move up and down, delete) and a **Layers** tree.
- **Style** and **Settings** tabs (right) for the selected element, with Undo
  and Redo.

Edits save by themselves a moment after you stop, as a new version that
contains only the changed files. If someone else published first, the page says
so and offers to reload rather than overwriting. An edit that would break the
board format (for example an external image) is not saved, and the page shows
the problem.

A board's CSS as written is kept as a **base layer** that always renders as
written; the editor's own changes are saved as a separate block on top. When a
writer first opens a version, the page renders each board as written and in the
editor and compares computed styles. Where they differ it lists "N styles may
not be editable on board X" under **Checks**: the board still looks right, but
those styles live only in the base layer, so the Style panel cannot change them.
To change them, edit the HTML and CSS in the repository or send a comment to a
coding agent.

### Comments on boards

Comment threads on a design are **pins**. Press `C` (or use the Comment
button), click an element in the canvas and write the comment; Esc leaves
comment mode. A pin is anchored to the element (its board, its id when it has
one, its tag, its first words and its path), plus the point you clicked as a
fraction of the element's box, so it stays on the element at every device
width. Open threads show as numbered pins; a resolved or outdated thread shows
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

The **History** tab lists versions as the Edits tray does for documents. Click a
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
accepts 20 guest registrations an hour. They can open the Edits tray and see
earlier versions and their changes, but cannot edit, restore, send to an agent
or share. Revoking a link signs its guests out at once;
expiring does the same on their next request.

Treat the URL as a bearer secret: anyone with it has the access, and guest
names prove nothing. Use short expiries, revoke when finished, and keep
sensitive material out of shared documents. Wardby does not rate-limit by
network address (it cannot know the real client address behind your load
balancer); put abuse controls for the `/s/` paths at your edge if the link is
public.

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
`allowWebhookTaskOverride`); every send checks this again. Native agents do not edit documents in this phase. Documents with
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
| Quoted anchor text           | 500 characters                                                                                            |
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
`board_format_invalid`, `board_too_large`, `comment_anchor_invalid`, `comment_too_long`,
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
