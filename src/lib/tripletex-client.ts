import type {
  ApiCallLog,
  TripletexListResponse,
  TripletexSingleResponse,
} from "../types/index.js";

export class TripletexClient {
  private _baseUrl: string;
  private authHeader: string;
  private callLog: ApiCallLog[] = [];

  constructor(baseUrl: string, sessionToken: string) {
    this._baseUrl = baseUrl.replace(/\/+$/, "");
    this.authHeader =
      "Basic " + Buffer.from(`0:${sessionToken}`).toString("base64");
  }

  get baseUrl(): string {
    return this._baseUrl;
  }

  get calls(): ReadonlyArray<ApiCallLog> {
    return this.callLog;
  }

  get stats() {
    const total = this.callLog.length;
    const errors = this.callLog.filter((c) => c.isError).length;
    const writeCalls = this.callLog.filter((c) => c.method !== "GET").length;
    const writeErrors = this.callLog.filter((c) => c.method !== "GET" && c.isError).length;
    const totalDuration = this.callLog.reduce((s, c) => s + c.durationMs, 0);
    return { total, errors, writeCalls, writeErrors, totalDuration };
  }

  private async request<T>(
    method: string,
    endpoint: string,
    options: { params?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`${this._baseUrl}${endpoint}`);
    if (options.params) {
      for (const [key, value] of Object.entries(options.params)) {
        url.searchParams.set(key, value);
      }
    }

    const start = performance.now();
    let status = 0;

    try {
      const res = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });

      status = res.status;
      const durationMs = Math.round(performance.now() - start);
      const isError = status >= 400;

      const logEntry: ApiCallLog = {
        method,
        endpoint,
        status,
        durationMs,
        isError,
        requestBody: options.body,
      };

      if (isError) {
        const errorBody = await res.text();
        logEntry.errorBody = errorBody;
        logEntry.responseBody = errorBody;
        this.callLog.push(logEntry);
        console.error(
          `[Tripletex] ${method} ${endpoint} → ${status} (${durationMs}ms)\n${errorBody}`,
        );
        throw new TripletexApiError(method, endpoint, status, errorBody);
      }

      console.log(
        `[Tripletex] ${method} ${endpoint} → ${status} (${durationMs}ms)`,
      );

      if (status === 204 || res.headers.get("content-length") === "0") {
        this.callLog.push(logEntry);
        return undefined as T;
      }

      const responseBody = (await res.json()) as T;
      logEntry.responseBody = responseBody;
      this.callLog.push(logEntry);
      return responseBody;
    } catch (error) {
      if (error instanceof TripletexApiError) throw error;

      const durationMs = Math.round(performance.now() - start);
      this.callLog.push({
        method,
        endpoint,
        status: 0,
        durationMs,
        isError: true,
        requestBody: options.body,
      });
      throw error;
    }
  }

  async get<T>(
    endpoint: string,
    params?: Record<string, string>,
  ): Promise<TripletexSingleResponse<T>> {
    return this.request("GET", endpoint, { params });
  }

  async list<T>(
    endpoint: string,
    params?: Record<string, string>,
  ): Promise<TripletexListResponse<T>> {
    return this.request("GET", endpoint, { params });
  }

  async post<T>(
    endpoint: string,
    body: unknown,
  ): Promise<TripletexSingleResponse<T>> {
    return this.request("POST", endpoint, { body });
  }

  async postList<T>(
    endpoint: string,
    body: unknown,
  ): Promise<TripletexListResponse<T>> {
    return this.request("POST", endpoint, { body });
  }

  async put<T>(
    endpoint: string,
    body: unknown,
  ): Promise<TripletexSingleResponse<T>> {
    return this.request("PUT", endpoint, { body });
  }

  async delete(endpoint: string): Promise<void> {
    await this.request<void>("DELETE", endpoint);
  }
}

export class TripletexApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly endpoint: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(
      `Tripletex API error: ${method} ${endpoint} → ${status}: ${body}`,
    );
    this.name = "TripletexApiError";
  }
}
