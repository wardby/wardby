/**
 * The contract between Wardby and a host provider's bound tools. A bound tool makes
 * one host operation; paging, markers, safeguards and wording stay in Wardby. Wardby
 * calls each tool with `{ workspace, repo, repository, ...operation fields }`.
 *
 * A tool answers with its operation's result, or `{ error: <decline code> }` when the
 * host refused. Results are untrusted and validated here, and a tool's own text never
 * reaches a model, a run record or a comment.
 */
import { z } from "zod";

export const HOST_TOOL_CONTRACT_VERSION = 1;

/** What a tool may say about a host refusal: fixed words, so no tool text passes through. */
export const HOST_TOOL_DECLINE_CODES = [
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "unavailable",
] as const;
export type HostToolDeclineCode = (typeof HOST_TOOL_DECLINE_CODES)[number];

const page = z.string().nullable();
const pullRequest = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string(),
    author: z.string().nullable(),
    state: z.string(),
    merged: z.boolean(),
    draft: z.boolean(),
    baseRef: z.string(),
    headRef: z.string(),
    headSha: z.string().min(1),
    isFork: z.boolean(),
    htmlUrl: z.string().url(),
  })
  .strict();
const written = z.object({ id: z.string().min(1) }).strict();

type OperationDef = {
  /** The HTTP methods this operation's requests may use. */
  methods: readonly string[];
  /** Changes nothing on the host: test_host_provider may call it. */
  readOnly: boolean;
  /** Which credential its `host` alias resolves to. */
  credential: "repository" | "permission" | "none";
  result: z.ZodType;
};

const read = (result: z.ZodType): OperationDef => ({
  methods: ["GET"],
  readOnly: true,
  credential: "repository",
  result,
});
const write = (methods: readonly string[], result: z.ZodType): OperationDef => ({
  methods,
  readOnly: false,
  credential: "repository",
  result,
});

export const HOST_OPERATIONS = {
  getPullRequest: read(pullRequest),
  listPullRequestFiles: read(
    z
      .object({
        files: z.array(
          z
            .object({
              filename: z.string(),
              status: z.string(),
              additions: z.number().int().nonnegative(),
              deletions: z.number().int().nonnegative(),
              previousFilename: z.string().optional(),
            })
            .strict(),
        ),
        nextPage: page,
      })
      .strict(),
  ),
  getDiff: read(z.object({ diff: z.string() }).strict()),
  findPullRequest: read(z.object({ pullRequest: pullRequest.nullable() }).strict()),
  readFile: read(
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("file"), content: z.string() }).strict(),
      z.object({ kind: z.literal("directory") }).strict(),
      z.object({ kind: z.literal("not_found") }).strict(),
    ]),
  ),
  listFiles: read(
    z
      .object({
        entries: z.array(
          z
            .object({
              path: z.string(),
              type: z.enum(["file", "directory"]),
              size: z.number().int().nonnegative().optional(),
            })
            .strict(),
        ),
        nextPage: page,
      })
      .strict(),
  ),
  listComments: read(
    z
      .object({
        comments: z.array(
          z
            .object({
              id: z.string().min(1),
              author: z.string().nullable(),
              authorId: z.string().nullable(),
              body: z.string(),
              createdAt: z.string(),
              path: z.string().nullable(),
              line: z.number().int().positive().nullable(),
              parentId: z.string().nullable(),
              resolved: z.boolean(),
            })
            .strict(),
        ),
        nextPage: page,
      })
      .strict(),
  ),
  listCommitStatuses: read(
    z
      .object({
        statuses: z.array(
          z
            .object({
              key: z.string(),
              state: z.enum(["pending", "success", "failure", "stopped"]),
              url: z.string().nullable(),
            })
            .strict(),
        ),
        nextPage: page,
      })
      .strict(),
  ),
  getRepositoryPermission: {
    methods: ["GET"],
    readOnly: true,
    credential: "permission",
    result: z.object({ permission: z.enum(["none", "read", "triage", "write", "maintain", "admin"]) }).strict(),
  },
  openPullRequest: write(["POST"], pullRequest),
  updatePullRequest: write(["PUT"], pullRequest),
  createComment: write(["POST"], written),
  editComment: write(["PUT"], written),
  resolveThread: write(["POST"], z.object({}).strict()),
  submitVerdict: write(["POST"], z.object({}).strict()),
  setCommitStatus: write(["POST"], z.object({}).strict()),
  // PR 5 gives this its HostEvent schema. Nothing calls it before then.
  normalizeEvent: { methods: [], readOnly: false, credential: "none", result: z.unknown() },
} as const satisfies Record<string, OperationDef>;

export type HostOperation = keyof typeof HOST_OPERATIONS;

export const REQUIRED_OPERATIONS: readonly HostOperation[] = [
  "getPullRequest",
  "listPullRequestFiles",
  "getDiff",
  "readFile",
  "listFiles",
  "listComments",
  "createComment",
  "submitVerdict",
  "findPullRequest",
  "openPullRequest",
  "updatePullRequest",
];

export function isHostOperation(name: string): name is HostOperation {
  return Object.hasOwn(HOST_OPERATIONS, name);
}
