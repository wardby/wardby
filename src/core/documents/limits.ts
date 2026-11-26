export const MAX_MARKDOWN_BYTES = 1_048_576;
export const MAX_COMMENT_CHARS = 10_000;
export const MAX_QUOTE_CHARS = 500;
export const MAX_CONTEXT_CHARS = 64;
/**
 * Serializable attempts for a document publish or a new thread (the shared default is 3). Both are
 * short, but several run on one document at once (an editor, MCP and the agent loop), and with the
 * backoff in withSerializableRetry six attempts span about half a second before a 409.
 */
export const DOCUMENT_WRITE_ATTEMPTS = 6;
/** Named reviewers per document (submit_for_review). */
export const MAX_REVIEWERS = 50;
/** A review note (verdict or force), the same cap as a comment; longer is comment_too_long. */
export const MAX_REVIEW_NOTE_CHARS = MAX_COMMENT_CHARS;
/** Review events returned with a document (newest first). */
export const MAX_REVIEW_EVENTS = 20;
