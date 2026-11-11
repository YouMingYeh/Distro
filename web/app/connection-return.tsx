"use client";

import { useEffect } from "react";

export function ConnectionReturn() {
  useEffect(() => {
    const result = document.getElementById("account-connection-result");
    result?.scrollIntoView({ block: "center" });
    result?.focus({ preventScroll: true });
  }, []);

  return null;
}
