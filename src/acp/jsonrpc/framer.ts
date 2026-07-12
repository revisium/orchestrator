import { JsonRpcProtocolError } from './errors.js';
import { parseJsonRpcMessage } from './parser.js';
import type { JsonRpcMessage } from './types.js';

export type JsonRpcFramer = {
  push(chunk: Uint8Array): JsonRpcMessage[];
  finish(): JsonRpcMessage[];
};

export type JsonRpcFramerOptions = {
  maxFrameBytes?: number;
};

const DEFAULT_MAX_FRAME_BYTES = 1_048_576;

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function parseLine(line: string): JsonRpcMessage | undefined {
  if (line === '') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (error) {
    throw new JsonRpcProtocolError('invalid_json', 'JSON-RPC frame is not valid JSON', error);
  }
  return parseJsonRpcMessage(value);
}

export function createJsonRpcFramer(options: JsonRpcFramerOptions = {}): JsonRpcFramer {
  const maxFrameBytes = positiveSafeInteger(
    options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
    'maxFrameBytes',
  );
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let encodedFrameBytes = 0;
  let finished = false;
  let failure: JsonRpcProtocolError | undefined;

  function ensureOpen(): void {
    if (failure) throw failure;
    if (finished) throw new JsonRpcProtocolError('closed', 'JSON-RPC framer is finished');
  }

  function run<T>(operation: () => T): T {
    ensureOpen();
    try {
      return operation();
    } catch (error) {
      if (error instanceof JsonRpcProtocolError &&
          (error.code === 'overflow' || error.code === 'invalid_utf8' ||
           error.code === 'invalid_json' || error.code === 'invalid_message')) {
        failure = error;
        text = '';
        encodedFrameBytes = 0;
      }
      throw error;
    }
  }

  function account(chunk: Uint8Array): void {
    for (const byte of chunk) {
      if (byte === 0x0a) {
        encodedFrameBytes = 0;
        continue;
      }
      encodedFrameBytes += 1;
      if (encodedFrameBytes > maxFrameBytes) {
        throw new JsonRpcProtocolError('overflow', `JSON-RPC frame exceeds ${String(maxFrameBytes)} bytes`);
      }
    }
  }

  function decode(chunk: Uint8Array, stream: boolean): string {
    try {
      return decoder.decode(chunk, { stream });
    } catch (error) {
      throw new JsonRpcProtocolError('invalid_utf8', 'JSON-RPC stream contains invalid UTF-8', error);
    }
  }

  function drainLines(): JsonRpcMessage[] {
    const messages: JsonRpcMessage[] = [];
    let newline = text.indexOf('\n');
    while (newline >= 0) {
      const rawLine = text.slice(0, newline);
      text = text.slice(newline + 1);
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      const message = parseLine(line);
      if (message) messages.push(message);
      newline = text.indexOf('\n');
    }
    return messages;
  }

  return {
    push(chunk): JsonRpcMessage[] {
      return run(() => {
        account(chunk);
        text += decode(chunk, true);
        return drainLines();
      });
    },
    finish(): JsonRpcMessage[] {
      return run(() => {
        text += decode(new Uint8Array(), false);
        const messages = drainLines();
        const finalMessage = parseLine(text);
        text = '';
        finished = true;
        if (finalMessage) messages.push(finalMessage);
        return messages;
      });
    },
  };
}
