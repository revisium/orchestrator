declare module 'ws' {
  export class WebSocketServer {
    constructor(options: { server: unknown; path: string });
    close(callback?: (error?: Error) => void): void;
  }
}
