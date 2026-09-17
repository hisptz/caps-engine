import axios from "axios";
import { env } from "@/shared/utils/env.ts";

export function chapRequestHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

export const chapClient = axios.create({
  baseURL: env.CHAP_BASE_URL,
  headers: chapRequestHeaders(env.CHAP_API_TOKEN),
});
