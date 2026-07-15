import { JsonRpcProtocolError } from './errors.js';
import { parseJsonRpcLine } from './parser.js';
import type { JsonRpcFramer, JsonRpcFramerOptions } from './framer.types.js';
import type { JsonRpcMessage } from './types.js';

export type { JsonRpcFramer, JsonRpcFramerOptions } from './framer.types.js';

const DEFAULT_MAX_FRAME_BYTES = 1_048_576;

export class AcpJsonRpcFramer implements JsonRpcFramer {
  private maxFrameBytes: number | undefined;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private text = '';
  private encodedFrameBytes = 0;
  private finished = false;
  private failure: JsonRpcProtocolError | undefined;

  private static resolveMaxFrameBytes(options: JsonRpcFramerOptions): number {
    const value = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError('maxFrameBytes must be a positive safe integer');
    }
    return value;
  }

  bindDependencies(options: JsonRpcFramerOptions = {}): void {
    if (this.maxFrameBytes !== undefined) throw new Error('ACP JSON-RPC framer is already bound');
    this.maxFrameBytes = AcpJsonRpcFramer.resolveMaxFrameBytes(options);
  }

  private getMaxFrameBytes(): number {
    if (this.maxFrameBytes === undefined) throw new Error('ACP JSON-RPC framer is not bound');
    return this.maxFrameBytes;
  }

  readonly push = (chunk: Uint8Array): JsonRpcMessage[] => {
    return this.executeWithFailureTracking(() => {
      this.trackFrameBytes(chunk);
      this.text += this.decodeUtf8Chunk(chunk, true);
      return this.parseBufferedLines();
    });
  };

  readonly finish = (): JsonRpcMessage[] => {
    return this.executeWithFailureTracking(() => {
      this.text += this.decodeUtf8Chunk(new Uint8Array(), false);
      const messages = this.parseBufferedLines();
      const finalMessage = parseJsonRpcLine(this.text);
      this.text = '';
      this.finished = true;
      if (finalMessage) messages.push(finalMessage);
      return messages;
    });
  };

  private assertFramerOpen(): void {
    if (this.failure) throw this.failure;
    if (this.finished) throw new JsonRpcProtocolError('closed', 'JSON-RPC framer is finished');
  }

  private executeWithFailureTracking<T>(operation: () => T): T {
    this.assertFramerOpen();
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

  private trackFrameBytes(chunk: Uint8Array): void {
    const maxFrameBytes = this.getMaxFrameBytes();
    for (const byte of chunk) {
      if (byte === 0x0a) {
        this.encodedFrameBytes = 0;
        continue;
      }
      this.encodedFrameBytes += 1;
      if (this.encodedFrameBytes > maxFrameBytes) {
        throw new JsonRpcProtocolError(
          'overflow',
          `JSON-RPC frame exceeds ${String(maxFrameBytes)} bytes`,
        );
      }
    }
  }

  private decodeUtf8Chunk(chunk: Uint8Array, stream: boolean): string {
    try {
      return this.decoder.decode(chunk, { stream });
    } catch (error) {
      throw new JsonRpcProtocolError('invalid_utf8', 'JSON-RPC stream contains invalid UTF-8', error);
    }
  }

  private parseBufferedLines(): JsonRpcMessage[] {
    const messages: JsonRpcMessage[] = [];
    let newline = this.text.indexOf('\n');
    while (newline >= 0) {
      const rawLine = this.text.slice(0, newline);
      this.text = this.text.slice(newline + 1);
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      const message = parseJsonRpcLine(line);
      if (message) messages.push(message);
      newline = this.text.indexOf('\n');
    }
    return messages;
  }
}

export function createJsonRpcFramer(options: JsonRpcFramerOptions = {}): JsonRpcFramer {
  const framer = new AcpJsonRpcFramer();
  framer.bindDependencies(options);
  return framer;
}
