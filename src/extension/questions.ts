import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import type { PermissionOption, Question } from "../shared/protocol.js";

/**
 * ACP has no first-class "ask the user a question" request. Agents that want
 * structured answers smuggle them through `session/request_permission`: the
 * question payload rides in vendor `_meta` fields, and the answers are
 * expected back in a non-standard response field.
 *
 * A client that ignores those fields shows an empty permission card and
 * returns no answers, which the agent reports as "no answers provided". This
 * module normalises every dialect we know about into one `Question[]` shape,
 * and describes how to encode the reply.
 */

/** How a given agent expects structured answers to be returned. */
export interface AnswerEncoding {
  /**
   * Where the answers map goes in the RequestPermissionResponse.
   * - "topLevel": a sibling of `outcome` (Qwen Code).
   * - "meta": nested under `_meta`.
   */
  placement: "topLevel" | "meta";
  /** Property name holding the answers map. */
  field: string;
  /** How each answer map key is derived. */
  key: "index" | "header";
}

export interface DetectedQuestions {
  questions: Question[];
  encoding: AnswerEncoding;
}

/** A `_meta` bag, which may sit on the request or on the tool call. */
type MetaBag = Record<string, unknown> | null | undefined;

function metaOf(request: RequestPermissionRequest): Record<string, unknown> {
  const requestMeta = (request as { _meta?: MetaBag })._meta ?? {};
  const toolMeta = (request.toolCall as { _meta?: MetaBag } | undefined)?._meta ?? {};
  // Tool-call meta wins: that is where agents attach per-call detail.
  return { ...requestMeta, ...toolMeta };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Coerce one agent-supplied question into our shape, tolerating missing or
 * malformed fields rather than dropping the whole prompt.
 */
function coerceQuestion(raw: unknown): Question | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;

  const text = asString(record.question) ?? asString(record.prompt) ?? asString(record.text);
  if (!text) return undefined;

  const rawOptions = Array.isArray(record.options) ? record.options : [];
  const options = rawOptions.flatMap((option): { label: string; description?: string }[] => {
    if (typeof option === "string") return [{ label: option }];
    const optionRecord = asRecord(option);
    const label = asString(optionRecord?.label) ?? asString(optionRecord?.name);
    if (!label) return [];
    return [{ label, description: asString(optionRecord?.description) }];
  });

  return {
    header: asString(record.header),
    question: text,
    options,
    multiSelect: record.multiSelect === true,
  };
}

function coerceQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const question = coerceQuestion(entry);
    return question ? [question] : [];
  });
}

/**
 * Detect a question-style permission request.
 *
 * Returns undefined for ordinary permission asks, which should render as a
 * normal allow/deny card.
 */
export function detectQuestions(
  request: RequestPermissionRequest,
): DetectedQuestions | undefined {
  const meta = metaOf(request);

  // Qwen Code: `_meta.qwenInteractionKind === "user_question"` with the
  // payload in `_meta.qwenQuestions`. Answers return as a top-level `answers`
  // map keyed by the question's index, stringified.
  if (meta.qwenInteractionKind === "user_question") {
    const questions = coerceQuestions(meta.qwenQuestions);
    if (questions.length > 0) {
      return {
        questions,
        encoding: { placement: "topLevel", field: "answers", key: "index" },
      };
    }
  }

  // Generic fallback: an agent that attaches `_meta.questions` without
  // claiming a dialect. Mirror the request shape back under `_meta`.
  const generic = coerceQuestions(meta.questions);
  if (generic.length > 0) {
    return {
      questions: generic,
      encoding: { placement: "meta", field: "answers", key: "index" },
    };
  }

  return undefined;
}

/**
 * Build the response body for a question form.
 *
 * `answers` arrives from the webview keyed by question index. We re-key it if
 * the agent expects headers, then place it where that agent looks for it.
 */
export function encodeAnswers(
  encoding: AnswerEncoding,
  questions: Question[],
  answers: Record<string, string>,
): Record<string, unknown> {
  const payload: Record<string, string> = {};

  for (const [index, value] of Object.entries(answers)) {
    if (value.length === 0) continue;
    if (encoding.key === "header") {
      const header = questions[Number(index)]?.header;
      payload[header ?? index] = value;
    } else {
      payload[index] = value;
    }
  }

  return encoding.placement === "topLevel"
    ? { [encoding.field]: payload }
    : { _meta: { [encoding.field]: payload } };
}

/**
 * Pick the option id to send when the user submits answers vs. dismisses the
 * form. Agents label these differently ("Submit"/"Cancel"), so select by the
 * protocol `kind` rather than by name.
 */
export function pickOutcomeOptions(options: PermissionOption[]): {
  submit: string | undefined;
  cancel: string | undefined;
} {
  const byKind = (...kinds: string[]) =>
    options.find((option) => kinds.includes(option.kind))?.optionId;

  return {
    submit: byKind("allow_once", "allow_always"),
    cancel: byKind("reject_once", "reject_always"),
  };
}
