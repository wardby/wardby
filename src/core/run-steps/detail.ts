/**
 * The detail level's text (RunStep.detail): a tool's input, the end of its output, a model
 * message. Redacted on the control plane, on the raw text, before any cut, against the same values
 * and forms as summaries (stepSummarizer): every form of every secret value (secretForms), matched
 * both in the text as written and in its whitespace-collapsed form (mapped back, so a secret the
 * model wrote with other spacing is masked while the text keeps its lines), the longest secret
 * start the text ends in (and, for an output whose head was cut, the longest secret end it starts
 * with), then token shapes (redactSecrets). Only then is it cut.
 */
import { REDACTED, redactSecrets } from "../../coding/redact.js";
import { maskSpans, mergeSpans, secretSpans } from "../secret-spans.js";
import { secretForms, secretTail } from "./summarize.js";
import {
  DETAIL_INPUT_CHARS,
  DETAIL_OUTPUT_CHARS,
  DETAIL_OUTPUT_HEADING,
  DETAIL_SAID_CHARS,
  MAX_RESULT_OUTPUT_CHARS,
  MAX_STEP_DETAIL_CHARS,
  MAX_STEP_TEXT_CHARS,
  type ExtractedResult,
  type ExtractedStep,
} from "./types.js";

const WS = /\s/;
// A PEM private key's lone edges: complete pairs are masked by redactSecrets first, so what
// matches here is a BEGIN whose END is not in the text, or an END whose BEGIN was cut away.
const PEM_BEGIN_TO_END = /-----BEGIN (?:[A-Z ]{1,32} )?PRIVATE KEY-----[\s\S]*$/;
const PEM_START_TO_END = /^[\s\S]*?-----END (?:[A-Z ]{1,32} )?PRIVATE KEY-----/;
const reverse = (text: string): string => text.split("").reverse().join("");

/**
 * `text` collapsed as summaries are (collapseWhitespace: runs of whitespace become one space,
 * trimmed), with each collapsed character's [from, to) span in `text`.
 */
export function collapseWithMap(text: string): { collapsed: string; from: number[]; to: number[] } {
  let start = 0;
  let end = text.length;
  while (start < end && WS.test(text[start])) start++;
  while (end > start && WS.test(text[end - 1])) end--;
  const parts: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  for (let i = start; i < end;) {
    if (WS.test(text[i])) {
      const run = i;
      while (i < end && WS.test(text[i])) i++;
      parts.push(" ");
      from.push(run);
      to.push(i);
    } else {
      parts.push(text[i]);
      from.push(i);
      to.push(i + 1);
      i++;
    }
  }
  return { collapsed: parts.join(""), from, to };
}

/** The end of `text`, at most `max` characters, and whether anything before it was dropped. */
export function tailOf(text: string, max = MAX_RESULT_OUTPUT_CHARS): { text: string; cut: boolean } {
  return text.length > max ? { text: text.slice(text.length - max), cut: true } : { text, cut: false };
}

/** What follows the first line break; nothing when there is none (a cut head leaves a partial first line). */
const afterFirstLine = (text: string): string => {
  const at = text.indexOf("\n");
  return at < 0 ? "" : text.slice(at + 1);
};

const headCut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A tool step's stored detail with its output appended, within MAX_STEP_DETAIL_CHARS. */
export function joinDetail(existing: string | null, suffix: string): string {
  return `${existing ?? ""}${suffix}`.slice(0, MAX_STEP_DETAIL_CHARS);
}

export interface StepDetailer {
  /** A step's detail: a tool's input (or its summary text when no input was sent), or a said step's text. */
  step(step: ExtractedStep): string;
  /** The text appended to a tool step's detail when its result arrives: the heading and the output's redacted end. */
  output(result: Required<Pick<ExtractedResult, "output">> & Pick<ExtractedResult, "outputCut">): string;
}

/**
 * Detail texts for one batch, against every secret value delivered to the run (the agent's and the
 * run's own). The forms, and each form's KMP table for the edge checks, are built once per batch.
 */
export function stepDetailer(secretValues: readonly string[]): StepDetailer {
  const forms = secretForms(secretValues);
  const reversedForms = forms.map(reverse);
  const tails = new Map<string, Int32Array>();
  const heads = new Map<string, Int32Array>();

  /**
   * `raw` with every occurrence of every form masked, as written and in its collapsed form, plus
   * the longest secret start it ends in (every text: a stream can stop mid-secret without saying
   * so) and, when its head was cut, the longest secret end it starts with; then token shapes.
   */
  const redact = (raw: string, headWasCut: boolean): string => {
    const text = raw.slice(0, MAX_STEP_TEXT_CHARS);
    const { collapsed, from, to } = collapseWithMap(text);
    const edges = (subject: string): string[] => {
      const found = [secretTail(subject, forms, tails)];
      if (headWasCut) found.push(reverse(secretTail(reverse(subject), reversedForms, heads)));
      return found.filter(Boolean);
    };
    const asWritten = secretSpans(text, [...forms, ...edges(text)], 1);
    const viaCollapsed = secretSpans(collapsed, [...forms, ...edges(collapsed)], 1).map(
      ([start, end]): [number, number] => [from[start], to[end - 1]],
    );
    const masked = maskSpans(text, mergeSpans([...asWritten, ...viaCollapsed]), REDACTED);
    // Token shapes (and Bearer values) after the exact values, as redactSecrets does for summaries.
    const shaped = redactSecrets(masked);
    const open = shaped.replace(PEM_BEGIN_TO_END, REDACTED);
    return headWasCut ? open.replace(PEM_START_TO_END, REDACTED) : open;
  };

  return {
    step(step) {
      if (step.kind === "said") return headCut(redact(step.text, false), DETAIL_SAID_CHARS);
      return headCut(redact(step.input ?? step.text, false), DETAIL_INPUT_CHARS);
    },
    output(result) {
      const source = tailOf(result.output);
      const headWasCut = result.outputCut === true || source.cut;
      // Redacted on everything available first. A text cut at its head then starts mid-line, where
      // a token shape's anchor (a label, a scheme, a BEGIN line) may be gone, so the partial first
      // line is dropped, after the 2 KiB cut as well as after the source's.
      let text = redact(source.text, headWasCut);
      let cut = headWasCut;
      if (cut) text = afterFirstLine(text);
      if (text.length > DETAIL_OUTPUT_CHARS - 1) {
        text = afterFirstLine(text.slice(text.length - (DETAIL_OUTPUT_CHARS - 1)));
        cut = true;
      }
      return `${DETAIL_OUTPUT_HEADING}${cut ? "…" : ""}${text}`;
    },
  };
}
