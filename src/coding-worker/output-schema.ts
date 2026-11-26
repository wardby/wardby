import {
  CODING_PROTOCOL_VERSION,
  TEST_OUTCOME_DESCRIPTION,
  TEST_OUTCOMES,
  PULL_REQUEST_CHOICE_DESCRIPTION,
} from "../coding/protocol.js";
import {
  COMMIT_SCOPE_DESCRIPTION,
  COMMIT_TITLE_DESCRIPTION,
  COMMIT_TYPE_DESCRIPTION,
  COMMIT_TYPES,
} from "../coding/commit-subject.js";

// OpenAI's strict Structured Outputs mode requires every property in an object schema with
// additionalProperties:false to be listed in "required" — an optional field is expressed as a
// nullable type (present, possibly null), never by omitting the key from "required". A field
// listed in properties but missing from required (as "tag" once was here) makes OpenAI reject
// the whole request with an HTTP 400 before the model ever runs.
export const CODING_OUTPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    schemaVersion: { type: "integer", const: CODING_PROTOCOL_VERSION },
    runId: { type: "string" },
    outcome: { type: "string", enum: ["changes_ready", "no_changes", "budget_exhausted"] },
    summary: {
      type: "string",
      description:
        "The full pull request description in Markdown, for every run including follow-ups: what changed, checklist, how to try it, and any closing line such as Resolves #N. It replaces the previous description.",
    },
    tag: {
      type: ["string", "null"],
      description:
        "Optional short label, such as a ticket id. At most 32 characters: letters, digits, '.', '_', '/', '-', starting with a letter or digit, with no spaces. Example: \"add-jokes\". Use null when there is no natural label.",
    },
    commitType: {
      type: ["string", "null"],
      enum: [...COMMIT_TYPES, null],
      description: COMMIT_TYPE_DESCRIPTION,
    },
    commitScope: {
      type: ["string", "null"],
      description: COMMIT_SCOPE_DESCRIPTION,
    },
    commitTitle: {
      type: ["string", "null"],
      description: COMMIT_TITLE_DESCRIPTION,
    },
    pullRequest: { type: ["string", "null"], enum: ["none", null], description: PULL_REQUEST_CHOICE_DESCRIPTION },
    tests: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        properties: {
          command: { type: "string" },
          outcome: { type: "string", enum: [...TEST_OUTCOMES], description: TEST_OUTCOME_DESCRIPTION },
        },
        required: ["command", "outcome"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "schemaVersion",
    "runId",
    "outcome",
    "summary",
    "tag",
    "commitType",
    "commitScope",
    "commitTitle",
    "pullRequest",
    "tests",
  ],
  additionalProperties: false,
} as const;

/** The output schema for a run; a run with extra repositories also describes each pull request (strict mode: nullable, never omitted). */
export function codingOutputJsonSchema(multi: boolean) {
  if (!multi) return CODING_OUTPUT_JSON_SCHEMA;
  return {
    ...CODING_OUTPUT_JSON_SCHEMA,
    properties: {
      ...CODING_OUTPUT_JSON_SCHEMA.properties,
      pullRequests: {
        type: ["array", "null"],
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            title: { type: ["string", "null"] },
            description: { type: "string" },
            mergeOrder: { type: ["integer", "null"], minimum: 1, maximum: 99 },
            pullRequest: {
              type: ["string", "null"],
              enum: ["none", null],
              description: PULL_REQUEST_CHOICE_DESCRIPTION,
            },
          },
          required: ["name", "title", "description", "mergeOrder", "pullRequest"],
          additionalProperties: false,
        },
      },
    },
    required: [...CODING_OUTPUT_JSON_SCHEMA.required, "pullRequests"],
  };
}
