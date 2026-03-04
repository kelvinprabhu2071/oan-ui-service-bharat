import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import { v4 as uuidv4 } from "uuid";
import {
  retryWithBackoff,
  DEFAULT_RETRY_CONFIG,
  isRetryableError,
  type RetryConfig,
} from "./retry-utils";
import { API_RETRY_CONFIG } from "@/config/retry";
import {
  API_URL,
  BYPASS_AUTH,
  AUTH_TOKEN,
  BYPASS_AUTH_MOBILE,
  BYPASS_AUTH_NAME,
  BYPASS_AUTH_ROLE,
  BYPASS_AUTH_METADATA,
} from "@/config/env";

export interface LocationData {
  latitude: number;
  longitude: number;
}

export interface ChatResponse {
  response: string;
  status: string;
}

export interface TranscriptionResponse {
  text: string;
  lang_code: string;
  status: string;
}

export interface SuggestionItem {
  question: string;
}

interface TTSResponse {
  status: string;
  audio_data: string;
  session_id: string;
}

interface AuthResponse {
  token: string;
}

// Constants
const JWT_STORAGE_KEY = "auth_jwt";

class ApiService {
  private apiUrl: string = API_URL;
  private locationData: LocationData | null = null;
  private currentSessionId: string | null = null;
  private axiosInstance: AxiosInstance;
  private authToken: string | null = null;
  private retryConfig: RetryConfig = API_RETRY_CONFIG;

  constructor() {
    this.authToken = this.getAuthToken();
    this.axiosInstance = axios.create({
      baseURL: this.apiUrl,
      headers: {
        "Content-Type": "application/json",
        Authorization: this.authToken ? `Bearer ${this.authToken}` : "NA",
      },
    });

    // Log the token being used
    // console.log('Using auth token:', this.authToken );
  }

  private getAuthToken(): string | null {
    // In bypass auth mode, the token is fetched dynamically from /api/token
    // and stored in localStorage by AuthContext. Fall through to localStorage lookup.
    try {
      const tokenData = localStorage.getItem(JWT_STORAGE_KEY);
      if (!tokenData) return null;

      const parsedData = JSON.parse(tokenData);
      const now = new Date().getTime();

      // Check if token is expired
      if (now > parsedData.expiry) {
        localStorage.removeItem(JWT_STORAGE_KEY);
        return null;
      }

      return parsedData.token;
    } catch (error) {
      console.error("Error retrieving JWT for API calls:", error);
      return null;
    }
  }

  private refreshAuthToken(): void {
    this.authToken = this.getAuthToken();
    if (this.authToken) {
      this.axiosInstance.defaults.headers.common[
        "Authorization"
      ] = `Bearer ${this.authToken}`;
    } else if (BYPASS_AUTH) {
      // In bypass mode without a token, use "NA" but don't redirect
      this.axiosInstance.defaults.headers.common["Authorization"] = "NA";
    } else {
      this.axiosInstance.defaults.headers.common["Authorization"] = "NA";
      this.redirectToErrorPage();
    }
  }

  private redirectToErrorPage(): void {
    // Check if we're in a browser environment and not already on error page
    if (
      typeof window !== "undefined" &&
      !window.location.pathname.includes("/error")
    ) {
      window.location.href = "/error?reason=auth";
    }
  }

  updateAuthToken(): void {
    this.refreshAuthToken();
  }

  private getAuthHeaders(): Record<string, string> {
    // Always get fresh token before generating headers
    this.refreshAuthToken();
    return {
      Authorization: this.authToken ? `Bearer ${this.authToken}` : "NA",
    };
  }

  private validateAuth(): boolean {
    // Skip auth validation in bypass mode
    if (BYPASS_AUTH) return true;
    if (!this.authToken) {
      this.redirectToErrorPage();
      return false;
    }
    return true;
  }

  /**
   * Update retry configuration
   */
  setRetryConfig(config: Partial<RetryConfig>): void {
    this.retryConfig = { ...this.retryConfig, ...config };
  }

  /**
   * Get current retry configuration
   */
  getRetryConfig(): RetryConfig {
    return { ...this.retryConfig };
  }

  async sendUserQuery(
    msg: string,
    session: string,
    sourceLang: string,
    targetLang: string,
    onStreamData?: (data: string) => void,
    onRetry?: (attempt: number, error: Error) => void
  ): Promise<ChatResponse> {
    const executeQuery = async (): Promise<ChatResponse> => {
      this.refreshAuthToken();
      if (!this.validateAuth()) {
        return { response: "Authentication error", status: "error" };
      }

      const params = {
        session_id: session,
        query: msg,
        source_lang: sourceLang,
        target_lang: targetLang,
        ...(this.locationData && {
          location: `${this.locationData.latitude},${this.locationData.longitude}`,
        }),
      };

      const headers = this.getAuthHeaders();

      if (onStreamData) {
        // 🟢 Mark network start
        if (window.__RESPONSE_TIMERS__) {
          // Need to know the questionId - it should be passed from ChatInterface
          // For now, get latest pending request
          const latestQid = Object.keys(window.__RESPONSE_TIMERS__)
            .reverse()
            .find(
              (qid) =>
                window.__RESPONSE_TIMERS__![qid]?.startTime &&
                !window.__RESPONSE_TIMERS__![qid]?.networkEndTime
            );

          if (latestQid) {
            window.__RESPONSE_TIMERS__![latestQid].networkStartTime =
              performance.now();
          }
        }

        // Handle streaming response
        const response = await fetch(
          `${this.apiUrl}/api/chat/?${new URLSearchParams(params)}`,
          {
            method: "GET",
            headers: headers,
          }
        );

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error("Response body is not readable");
        }

        let fullResponse = "";
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          fullResponse += chunk;
          onStreamData(chunk);
        }

        // 🟢 Mark network end
        if (window.__RESPONSE_TIMERS__) {
          const latestQid = Object.keys(window.__RESPONSE_TIMERS__)
            .reverse()
            .find(
              (qid) =>
                window.__RESPONSE_TIMERS__![qid]?.networkStartTime &&
                !window.__RESPONSE_TIMERS__![qid]?.networkEndTime
            );

          if (latestQid) {
            window.__RESPONSE_TIMERS__![latestQid].networkEndTime =
              performance.now();
          }
        }

        return { response: fullResponse, status: "success" };
      } else {
        // Regular non-streaming request
        const config = {
          params,
          headers: this.getAuthHeaders(),
        };
        const response = await this.axiosInstance.get("/api/chat/", config);
        return response.data;
      }
    };

    try {
      return await retryWithBackoff(executeQuery, this.retryConfig, onRetry);
    } catch (error) {
      console.error("Error sending user query after retries:", error);
      throw error;
    }
  }

  async getSuggestions(
    session: string,
    targetLang: string = "hi"
  ): Promise<SuggestionItem[]> {
    const executeSuggestions = async (): Promise<SuggestionItem[]> => {
      this.refreshAuthToken();
      if (!this.validateAuth()) {
        return [];
      }

      const params = {
        session_id: session,
        target_lang: targetLang,
      };

      const config = {
        params,
        headers: this.getAuthHeaders(),
      };

      const response = await this.axiosInstance.get("/api/suggest/", config);
      return response.data.map((item: string) => ({
        question: item,
      }));
    };

    try {
      return await retryWithBackoff(executeSuggestions, this.retryConfig);
    } catch (error) {
      console.error("Error getting suggestions after retries:", error);
      throw error;
    }
  }

  async transcribeAudio(
    audioBase64: string,
    serviceType: string = "bhashini",
    sessionId: string,
    lang_code: string
  ): Promise<TranscriptionResponse> {
    try {
      this.refreshAuthToken();
      if (!this.validateAuth()) {
        return { text: "", lang_code: "", status: "error" };
      }

      const payload = {
        audio_content: audioBase64,
        service_type: serviceType,
        session_id: sessionId,
        lang_code: lang_code,
      };

      // Explicitly set headers for this request
      const config = {
        headers: this.getAuthHeaders(),
      };

      const response = await this.axiosInstance.post(
        "/api/transcribe/",
        payload,
        config
      );
      return response.data;
    } catch (error) {
      console.error("Error transcribing audio:", error);
      throw error;
    }
  }

  getTranscript(
    sessionId: string,
    text: string,
    targetLang: string
  ): Promise<AxiosResponse<TTSResponse>> {
    this.refreshAuthToken();
    if (!this.validateAuth()) {
      return Promise.reject(new Error("Authentication required"));
    }

    const config = {
      headers: this.getAuthHeaders(),
    };

    return this.axiosInstance.post(
      `/api/tts/`,
      {
        session_id: sessionId,
        text: text,
        target_lang: targetLang,
      },
      config
    );
  }

  // Stream TTS response and emit decoded audio bytes progressively
  async streamTranscript(
    sessionId: string,
    text: string,
    targetLang: string,
    onBytes: (bytes: Uint8Array) => void
  ): Promise<Uint8Array> {
    // Ensure we have a fresh auth token and validate before making the call
    this.refreshAuthToken();
    if (!this.validateAuth()) {
      return new Uint8Array();
    }

    const payload = {
      session_id: sessionId,
      text: text,
      target_lang: targetLang,
    };
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.getAuthHeaders(),
    };

    const response = await fetch(`${this.apiUrl}/api/tts/`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      // Fallback to non-streaming JSON if body isn't readable
      const json = await response.json();
      const base64 = (json?.audio_data ||
        json?.data?.audio_data ||
        "") as string;
      if (!base64) return new Uint8Array();
      const binaryString = atob(base64);
      const out = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++)
        out[i] = binaryString.charCodeAt(i);
      onBytes(out);
      return out;
    }

    const decoder = new TextDecoder();
    let textBuf = "";
    let base64Buf = "";
    let foundStart = false;
    const chunks: Uint8Array[] = [];

    const flushDecodable = () => {
      // Only decode multiples of 4 to keep Base64 alignment
      const len = base64Buf.length - (base64Buf.length % 4);
      if (len <= 0) return;
      const slice = base64Buf.slice(0, len);
      base64Buf = base64Buf.slice(len);
      if (!slice) return;
      try {
        const bin = atob(slice);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        onBytes(bytes);
        chunks.push(bytes);
      } catch (e) {
        console.warn(
          "Base64 decode failed for slice; skipping until next chunk"
        );
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = decoder.decode(value, { stream: true });
      textBuf += part;

      if (!foundStart) {
        const idx = textBuf.indexOf('"audio_data"');
        if (idx >= 0) {
          // Find the first quote after colon
          const colonIdx = textBuf.indexOf(":", idx);
          const firstQuote = textBuf.indexOf('"', colonIdx + 1);
          if (firstQuote >= 0) {
            foundStart = true;
            // Everything after firstQuote+1 contributes to base64, until closing quote
            base64Buf += textBuf.slice(firstQuote + 1);
          }
        }
      } else {
        base64Buf += part;
      }

      if (foundStart) {
        // Stop consuming when we reach a closing quote for audio_data
        const closing = base64Buf.indexOf('"');
        if (closing >= 0) {
          const b64 = base64Buf.slice(0, closing);
          base64Buf = b64; // trim to exact content
          flushDecodable();
          // Decode any leftover
          if (base64Buf.length > 0) {
            try {
              const bin = atob(base64Buf);
              const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              onBytes(bytes);
              chunks.push(bytes);
            } catch (e) {
              console.warn("Final base64 decode failed", e);
            }
          }
          break; // We are done reading audio_data field
        } else {
          flushDecodable();
        }
      }
    }

    // Concatenate chunks to a single Uint8Array
    let totalLen = 0;
    for (const c of chunks) totalLen += c.length;
    const out = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        try {
          const base64String = (reader.result as string).split(",")[1];
          resolve(base64String);
        } catch (error) {
          reject(new Error("Failed to convert blob to base64"));
        }
      };
      reader.onerror = () => reject(new Error("Failed to read blob"));
      reader.readAsDataURL(blob);
    });
  }

  setLocationData(location: LocationData): void {
    this.locationData = location;
  }

  getLocationData(): LocationData | null {
    return this.locationData;
  }

  setSessionId(sessionId: string): void {
    this.currentSessionId = sessionId;
  }

  getSessionId(): string | null {
    return this.currentSessionId;
  }

  async fetchAuthToken(metadata: string): Promise<string> {
    try {
      // Don't use authentication headers for this call as we're getting the token
      const response = await axios.post<AuthResponse>(
        `${this.apiUrl}/api/token`,
        {
          metadata,
        },
        {
          headers: {
            "Content-Type": "application/json",
          },
        }
      );

      if (response.data && response.data.token) {
        return response.data.token;
      }

      throw new Error("No token received from auth endpoint");
    } catch (error) {
      console.error("Error fetching auth token:", error);
      throw error;
    }
  }

  /**
   * Fetch a bypass/dev token from POST /api/token using the full payload.
   * Used when BYPASS_AUTH=true to dynamically obtain a real access token.
   */
  async fetchBypassToken(payload: {
    mobile: string;
    name: string;
    role: string;
    metadata: string | null;
  }): Promise<{ token: string; expires_in: number }> {
    try {
      const response = await axios.post<{ token: string; expires_in: number }>(
        `${this.apiUrl}/api/token`,
        payload,
        {
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        }
      );

      const token = response.data.token;
      if (token) {
        return { token, expires_in: response.data.expires_in || 900 };
      }

      throw new Error("No token received from /api/token");
    } catch (error) {
      console.error("[Bypass Auth] Error fetching token from /api/token:", error);
      throw error;
    }
  }
}

// Create a singleton instance
const apiService = new ApiService();
export default apiService;
