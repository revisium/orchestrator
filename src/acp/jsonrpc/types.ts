export type JsonRpcPrimitive = null | boolean | number | string;
export type JsonRpcValue = JsonRpcPrimitive | JsonRpcValue[] | { [key: string]: JsonRpcValue };
export type JsonRpcParams = JsonRpcValue[] | { [key: string]: JsonRpcValue };
export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  jsonrpc: '2.0';
  method: string;
  params?: JsonRpcParams;
  id: JsonRpcId;
};

export type JsonRpcNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: JsonRpcParams;
};

export type JsonRpcErrorObject = {
  code: number;
  message: string;
  data?: JsonRpcValue;
};

export type JsonRpcSuccessResponse = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: JsonRpcValue;
};

export type JsonRpcErrorResponse = {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
};

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

export type JsonRpcProtocolFailureCode =
  | 'overflow'
  | 'invalid_utf8'
  | 'invalid_json'
  | 'invalid_message'
  | 'unknown_response_id'
  | 'duplicate_response_id'
  | 'uncorrelated_null_response'
  | 'request_id_exhausted'
  | 'remote_error'
  | 'send_failed'
  | 'handler_failed'
  | 'closed';
