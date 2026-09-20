/**
 * The webview's side of `api_send`.
 *
 * Thin on purpose. Everything that can be decided without a socket — what a
 * half-typed URL means, which headers are enabled, what a content type implies
 * — is a pure function in `url.ts` and `format.ts`, tested under Node. This
 * file is only the crossing.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { ApiError, ApiProgress, ApiResponse, SendInput } from "../../types/api";

const PROGRESS_EVENT = "api://progress";

/** A fresh id per send; it is also the handle `cancelRequest` takes. */
export function newRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Narrows what `invoke` rejects with.
 *
 * Tauri passes a command's `Err` value through as-is, so a failed send arrives
 * as the `SendError` struct — but a command that is missing, or an argument
 * that will not deserialise, arrives as a bare string. Both have to be handled
 * or a typo in a command name shows up as a blank error panel.
 */
export function toApiError(error: unknown): ApiError {
  if (
    error &&
    typeof error === "object" &&
    "kind" in error &&
    "message" in error &&
    typeof (error as ApiError).message === "string"
  ) {
    return error as ApiError;
  }
  return { kind: "other", message: String(error) };
}

/** Sends one request. Rejects with an `ApiError`, including when cancelled. */
export async function sendRequest(input: SendInput): Promise<ApiResponse> {
  try {
    return await invoke<ApiResponse>("api_send", { input });
  } catch (error) {
    throw toApiError(error);
  }
}

/** Stops a send. Safe to call for one that has already come back. */
export async function cancelRequest(id: string): Promise<boolean> {
  try {
    return await invoke<boolean>("api_cancel", { id });
  } catch {
    return false;
  }
}

/** Download progress for whichever send is in flight. */
export function onApiProgress(
  handler: (progress: ApiProgress) => void
): Promise<UnlistenFn> {
  return listen<ApiProgress>(PROGRESS_EVENT, (event) => handler(event.payload));
}
