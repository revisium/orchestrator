import type {
  AcpInitializeResponse,
  AcpNewSessionResponse,
  AcpSetSessionConfigOptionRequest,
  AcpSetSessionConfigOptionResponse,
} from '../protocol/values.js';

export type AcpConnectorContext = Readonly<{
  initialization: AcpInitializeResponse;
  session: AcpNewSessionResponse;
  setConfigOption(
    request: AcpSetSessionConfigOptionRequest,
  ): Promise<AcpSetSessionConfigOptionResponse>;
}>;

export type AcpConnector = Readonly<{
  configure(context: AcpConnectorContext): Promise<void>;
}>;
