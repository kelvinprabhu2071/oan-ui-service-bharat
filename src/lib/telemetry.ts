// --- V3 Telemetry Specification Alignment ---
import FingerprintJS from "@fingerprintjs/fingerprintjs";
import { UAParser } from "ua-parser-js";
import {
  TELEMETRY_HOST,
} from "@/config/env";

// Telemetry constants (non-configurable)
const TELEMETRY_KEY = "";
const TELEMETRY_SECRET = "";
const TELEMETRY_CHANNEL = "BharatVistaar";
const TELEMETRY_PRODUCT_ID = "BharatVistaar";
const TELEMETRY_PRODUCT_VERSION = "v0.1";
const TELEMETRY_PRODUCT_PID = "BharatVistaar";

// FingerprintJS initialization

window.__FINGERPRINT_CONTEXT__ = {
  ready: false,
  data: null,
};
declare global {
  interface Window {
    __FINGERPRINT_CONTEXT__: any;
    __RESPONSE_TIMERS__?: Record<
      string,
      {
        startTime?: number; // Request start (for UI rendering)
        networkStartTime?: number; // When API call starts
        networkEndTime?: number; // When API response completes
        renderStart?: number; // When rendering starts
        paintTime?: number; // When rendering completes
      }
    >;
  }
}

window.__RESPONSE_TIMERS__ = window.__RESPONSE_TIMERS__ || {};

// telemetry.ts
export const initChatApiPerformanceObserver = () => {
  if (!("PerformanceObserver" in window)) return;

  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.entryType === "resource" && entry.name.includes("/api/chat/")) {
        // Attach timing to the latest unanswered question
        const timers = window.__RESPONSE_TIMERS__;
        if (!timers) return;

        const latestQid = Object.keys(timers)
          .reverse()
          .find((qid) => timers[qid]?.startTime && !timers[qid]?.responseEnd);

        if (!latestQid) return;

        // Cast to PerformanceResourceTiming to access responseStart/responseEnd
        const resourceTiming = entry as PerformanceResourceTiming;

        // Store responseStart (TTFB - Time To First Byte) and responseEnd
        timers[latestQid].responseStart = resourceTiming.responseStart;
        timers[latestQid].responseEnd = resourceTiming.responseEnd;
        // ← ADD THIS LINE:
        notifyResponseDataReady(latestQid);
      }
    }
  });

  observer.observe({ type: "resource", buffered: true });
};

// Device code helpers
const mapBrowserCode = (name = "") =>
  ({ chrome: "CH", firefox: "FF", safari: "SF", edge: "ED" })[
    name.toLowerCase()
  ] || "OT";

const mapOSCode = (name = "") =>
  ({ windows: "WIN", macos: "MAC", android: "AND", ios: "IOS", linux: "LNX" })[
    name.toLowerCase()
  ] || "OT";

const mapDeviceCode = (type = "") =>
  ({ mobile: "MB", tablet: "TB", desktop: "DT" })[type?.toLowerCase()] || "DT";

// Declare V3 Telemetry methods required for this implementation
// Note: Implementations for all methods are assumed to exist in the global Telemetry object.
declare let Telemetry: any;
declare let AuthTokenGenerate: any;

// Function to get the current host URL
const getHostUrl = (): string => {
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return "unknown-host";
};

// inititalize fingerprint and UAparser
const initFingerprintContext = async (sessionStartAt: number) => {
  const cached = localStorage.getItem("fingerprint_context");

  if (cached) {
    window.__FINGERPRINT_CONTEXT__ = JSON.parse(cached);
    window.__FINGERPRINT_CONTEXT__.ready = true;
    return;
  }

  const fp = await FingerprintJS.load();
  const result = await fp.get();
  const ua = new UAParser().getResult();

  const context = {
    ready: true,
    data: {
      device_id: result.visitorId,

      browser: {
        code: mapBrowserCode(ua.browser.name),
        name: ua.browser.name,
        version: ua.browser.version,
      },

      device: {
        code: mapDeviceCode(ua.device.type),
        name: ua.device.type || "Desktop",
        model: ua.device.model || "Unknown",
      },

      os: {
        code: mapOSCode(ua.os.name),
        name: ua.os.name,
        version: ua.os.version,
      },

      session: {
        session_start_at: sessionStartAt,
        session_end_at: null,
      },

      device_lifecycle: {
        first_seen_at: sessionStartAt,
        last_seen_at: sessionStartAt,
      },
    },
  };

  localStorage.setItem("fingerprint_context", JSON.stringify(context));
  window.__FINGERPRINT_CONTEXT__ = context;
};

export const startTelemetry = async (
  sessionId: string,
  userDetailsObj: { preferred_username: string; email: string },
) => {
  const sessionStartAt = Date.now();

  await initFingerprintContext(sessionStartAt);

  initChatApiPerformanceObserver();

  const config = {
    pdata: {
      id: TELEMETRY_PRODUCT_ID,
      ver: TELEMETRY_PRODUCT_VERSION,
      pid: TELEMETRY_PRODUCT_PID,
    },
    channel: TELEMETRY_CHANNEL + "-" + getHostUrl(),
    sid: sessionId,
    uid: userDetailsObj["preferred_username"] || "DEFAULT-USER",
    did: userDetailsObj["email"] || "DEFAULT-USER",
    authtoken: "",
    host: TELEMETRY_HOST,
  };

  const startEdata = {};
  const options = {};
  const token = AuthTokenGenerate.generate(TELEMETRY_KEY, TELEMETRY_SECRET);
  config.authtoken = token;
  Telemetry.start(config, "content_id", "contetn_ver", startEdata, options);
};

export const markServerRequestStart = (qid: string) => {
  window.__RESPONSE_TIMERS__![qid] = {
    startTime: performance.now(),
  };
};

export const markAnswerRendered = (qid: string, callback?: () => void) => {
  requestAnimationFrame(() => {
    const timer = window.__RESPONSE_TIMERS__?.[qid];
    if (!timer) return;

    timer.paintTime = performance.now();
    console.log("PAINT RECORDED", qid, timer);

    notifyResponseDataReady(qid); // ← ADD THIS

    // Call callback after paint is recorded
    if (callback) callback();
  });
};

export const logQuestionEvent = (
  questionId: string,
  sessionId: string,
  questionText: string,
) => {
  const target = {
    id: "default",
    ver: "v0.1",
    type: "Question",
    parent: {
      id: "p1",
      type: "default",
    },
    questionsDetails: {
      questionText: questionText,
      sessionId: sessionId,
    },
  };

  const questionData = {
    qid: questionId,
    type: "CHOOSE",
    target: target,
    sid: sessionId,
    channel: TELEMETRY_CHANNEL + "-" + getHostUrl(),
  };

  Telemetry.response(questionData);
};

export const logResponseEvent = (
  questionId: string,
  sessionId: string,
  questionText: string,
  responseText: string,
) => {
  // Calculate performance metrics
  const timer = window.__RESPONSE_TIMERS__?.[questionId];
  const serverResponseTime =
    timer?.responseEnd && timer?.responseStart
      ? Math.round(timer.responseEnd - timer.responseStart)
      : null;
  const browserRenderTime =
    timer?.paintTime && timer?.responseEnd
      ? Math.round(timer.paintTime - timer.responseEnd)
      : null;

  const target = {
    id: "default",
    ver: "v0.1",
    type: "QuestionResponse",
    parent: {
      id: "p1",
      type: "default",
    },
    questionsDetails: {
      questionText: questionText,
      answerText: responseText,
      sessionId: sessionId,
    },
    performance: {
      server_response_time_ms: serverResponseTime,
      browser_render_time_ms: browserRenderTime,
    },
  };

  const responseData = {
    qid: questionId,
    type: "CHOOSE",
    target: target,
    sid: sessionId,
    channel: TELEMETRY_CHANNEL + "-" + getHostUrl(),
    values: [],
  };

  Telemetry.response(responseData);
};

export const logErrorEvent = (
  questionId: string,
  sessionId: string,
  error: string,
) => {
  const target = {
    id: "default",
    ver: "v0.1",
    type: "Error",
    parent: {
      id: "p1",
      type: "default",
    },
    errorDetails: {
      errorText: error,
      sessionId: sessionId,
    },
  };

  const errorData = {
    qid: questionId,
    type: "CHOOSE",
    target: target,
    sid: sessionId,
    channel: TELEMETRY_CHANNEL + "-" + getHostUrl(),
  };

  Telemetry.response(errorData);
};

export const logFeedbackEvent = (
  questionId: string,
  sessionId: string,
  feedbackText: string,
  feedbackType: string,
  questionText: string,
  responseText: string,
) => {
  const target = {
    id: "default",
    ver: "v0.1",
    type: "Feedback",
    parent: {
      id: "p1",
      type: "default",
    },
    feedbackDetails: {
      feedbackText: feedbackText,
      sessionId: sessionId,
      questionText: questionText,
      answerText: responseText,
      feedbackType: feedbackType,
    },
  };

  const feedbackData = {
    qid: questionId,
    type: "CHOOSE",
    target: target,
    sid: sessionId,
    channel: TELEMETRY_CHANNEL + "-" + getHostUrl(),
  };

  Telemetry.response(feedbackData);
};

export const endTelemetry = () => {
  Telemetry.end({});
};

// Track when response data is ready for each question
const responseDataReady: Map<string, Promise<void>> = new Map();

// Call this from PerformanceObserver when response data arrives
export const notifyResponseDataReady = (qid: string) => {
  if (!responseDataReady.has(qid)) {
    let resolve: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    responseDataReady.set(qid, promise);
    resolve!();
  } else {
    // If already set, resolve it immediately
    responseDataReady.get(qid);
  }
};

export const endTelemetryWithWait = async (qid: string, timeout = 3000) => {
  const startWait = Date.now();

  // Check if response data is already ready
  const timer = window.__RESPONSE_TIMERS__?.[qid];
  if (timer?.responseEnd && timer?.paintTime) {
    console.log(`Response data already captured for ${qid}`);
    Telemetry.end({});
    return;
  }

  // Wait for response data notification
  try {
    const readyPromise =
      responseDataReady.get(qid) ||
      new Promise<void>((resolve) => {
        // Create a waiting promise that resolves when data arrives
        const checkInterval = setInterval(() => {
          const t = window.__RESPONSE_TIMERS__?.[qid];
          if (t?.responseEnd && t?.paintTime) {
            clearInterval(checkInterval);
            console.log(`Response data arrived for ${qid}`);
            resolve();
          }
          if (Date.now() - startWait > timeout) {
            clearInterval(checkInterval);
            console.warn(`Timeout waiting for response data for ${qid}`);
            resolve();
          }
        }, 100);
      });

    await Promise.race([
      readyPromise,
      new Promise<void>((resolve) => setTimeout(resolve, timeout)),
    ]);
  } catch (error) {
    console.warn(`Error waiting for response data: ${error}`);
  }

  // Call telemetry endpoint
  Telemetry.end({});

  // Cleanup
  responseDataReady.delete(qid);
};

export const getServerResponseTime = (qid: string): number | null => {
  const timer = window.__RESPONSE_TIMERS__?.[qid];
  if (!timer || !timer.responseStart || !timer.responseEnd) return null;

  // Server response time = time from server starts sending to finishes sending
  return timer.responseEnd - timer.responseStart;
};

export const getBrowserRenderTime = (qid: string): number | null => {
  const timer = window.__RESPONSE_TIMERS__?.[qid];
  if (!timer || !timer.responseEnd || !timer.paintTime) return null;

  // Browser render time = time from response end to paint/render
  return timer.paintTime - timer.responseEnd;
};

export const getTotalResponseTime = (qid: string): number | null => {
  const timer = window.__RESPONSE_TIMERS__?.[qid];
  if (!timer || !timer.startTime || !timer.paintTime) return null;

  // Total time from request start to paint
  return timer.paintTime - timer.startTime;
};

export const getNetworkWaitTime = (qid: string): number | null => {
  const timer = window.__RESPONSE_TIMERS__?.[qid];
  if (!timer || !timer.startTime || !timer.responseStart) return null;

  // Network wait time (TTFB) = from request start to first byte received
  return timer.responseStart - timer.startTime;
};

export const getTimingMetrics = (qid: string) => {
  return {
    serverResponseTime: getServerResponseTime(qid),
    browserRenderTime: getBrowserRenderTime(qid),
    totalResponseTime: getTotalResponseTime(qid),
    networkWaitTime: getNetworkWaitTime(qid),
    rawTimers: window.__RESPONSE_TIMERS__?.[qid],
  };
};
