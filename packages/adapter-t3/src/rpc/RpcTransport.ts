export interface RpcTransport {
  request<T>(method: string, payload: unknown, timeoutMs?: number): Promise<T>;
  stream<T>(method: string, payload: unknown, signal?: AbortSignal): AsyncIterable<T>;
  close(): Promise<void>;
  isOpen(): boolean;
}
