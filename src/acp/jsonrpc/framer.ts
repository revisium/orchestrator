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

class JsonRpcFramerImpl implements JsonRpcFramer {
  private readonly maxFrameBytes: number;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private text = '';
  private encodedFrameBytes = 0;
  private finished = false;
  private failure: JsonRpcProtocolError | undefined;

  constructor(options: JsonRpcFramerOptions) {
    this.maxFrameBytes = positiveSafeInteger(
      options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      'maxFrameBytes',
    );
  }

  readonly push = (chunk: Uint8Array): JsonRpcMessage[] => {
    return this.run(() => {
      this.account(chunk);
      this.text += this.decode(chunk, true);
      return this.drainLines();
    });
  };

  readonly finish = (): JsonRpcMessage[] => {
    return this.run(() => {
      this.text += this.decode(new Uint8Array(), false);
      const messages = this.drainLines();
      const finalMessage = parseLine(this.text);
      this.text = '';
      this.finished = true;
      if (finalMessage) messages.push(finalMessage);
      return messages;
    });
  };

  private ensureOpen(): void {
    if (this.failure) throw this.failure;
    if (this.finished) throw new JsonRpcProtocolError('closed', 'JSON-RPC framer is finished');
  }

  private run<T>(operation: () => T): T {
    this.ensureOpen();
    try {
      return operation();
    } catch (error) {
      if (
        error instanceof JsonRpcProtocolError &&
        (error.code === 'overflow' ||
          error.code === 'invalid_utf8' ||
          error.code === 'invalid_json' ||
          error.code === 'invalid_message')
      ) {
        this.failure = error;
        this.text = '';
        this.encodedFrameBytes = 0;
      }
      throw error;
    }
  }

  private account(chunk: Uint8Array): void {
    for (const byte of chunk) {
      if (byte === 0x0a) {
        this.encodedFrameBytes = 0;
        continue;
      }
      this.encodedFrameBytes += 1;
      if (this.encodedFrameBytes > this.maxFrameBytes) {
        throw new JsonRpcProtocolError(
          'overflow',
          `JSON-RPC frame exceeds ${String(this.maxFrameBytes)} bytes`,
        );
      }
    }
  }

  private decode(chunk: Uint8Array, stream: boolean): string {
    try {
      return this.decoder.decode(chunk, { stream });
    } catch (error) {
      throw new JsonRpcProtocolError('invalid_utf8', 'JSON-RPC stream contains invalid UTF-8', error);
    }
  }

  private drainLines(): JsonRpcMessage[] {
    const messages: JsonRpcMessage[] = [];
    let newline = this.text.indexOf('\n');
    while (newline >= 0) {
      const rawLine = this.text.slice(0, newline);
      this.text = this.text.slice(newline + 1);
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      const message = parseLine(line);
      if (message) messages.push(message);
      newline = this.text.indexOf('\n');
    }
    return messages;
  }
}

export function createJsonRpcFramer(options: JsonRpcFramerOptions = {}): JsonRpcFramer {
  return new JsonRpcFramerImpl(options);
}
