import type { AiLike, AiRunInput } from '../ai.js';

export interface AiCall {
  model: string;
  input: AiRunInput;
}

export type AiReply = unknown | Error | ((call: AiCall) => unknown);

/**
 * A fake Workers AI binding: replies in order (the last repeats), each a JSON object (answered as `{ response, usage }`), a raw
 * `{ raw }` string, an Error, or a function of the call. No network.
 */
export class FakeAi implements AiLike {
  readonly calls: AiCall[] = [];
  private readonly replies: AiReply[];

  constructor(...replies: AiReply[]) {
    this.replies = replies;
  }

  /** Token counts the fake reports as usage (neurons follow from the model's rates). */
  usage = { prompt_tokens: 4000, completion_tokens: 500 };

  run(model: string, input: AiRunInput): Promise<unknown> {
    const call = { model, input };
    this.calls.push(call);
    const reply = this.replies.length > 1 ? this.replies.shift() : this.replies[0];
    const value = typeof reply === 'function' ? (reply as (call: AiCall) => unknown)(call) : reply;
    if (value instanceof Error) return Promise.reject(value);
    if (value !== null && typeof value === 'object' && 'raw' in value) return Promise.resolve({ response: (value as { raw: string }).raw, usage: this.usage });
    return Promise.resolve({ response: value, usage: this.usage });
  }
}
