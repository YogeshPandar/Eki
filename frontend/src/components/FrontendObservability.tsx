"use client";

import { useEffect } from "react";
import { useReportWebVitals } from "next/web-vitals";
import {
  flushFrontendObservability,
  recordFrontendError,
  recordWebVital,
} from "@/lib/observability";

const reportWebVital: Parameters<typeof useReportWebVitals>[0] = (metric) => {
  recordWebVital(metric.name, metric.value, metric.rating);
};

export default function FrontendObservability() {
  useReportWebVitals(reportWebVital);

  useEffect(() => {
    const onError = () => recordFrontendError("window_error");
    const onRejection = () => recordFrontendError("unhandled_rejection");
    const onHidden = () => {
      if (document.visibilityState === "hidden") void flushFrontendObservability();
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, []);

  return null;
}
