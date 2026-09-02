import { awsApiBaseUrl } from "@/lib/awsStaging";

const apiUrl = (path: string) => `${awsApiBaseUrl()}${path}`;

async function workflowFetch(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json");
  headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(apiUrl(path), { ...init, headers });
  let body: Record<string, unknown> = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return { ok: response.ok, status: response.status, body };
}

export async function createAwsCheck(
  token: string,
  values: Record<string, unknown> = {},
): Promise<{ check: Record<string, unknown>; imagePrefix: string }> {
  const { ok, body } = await workflowFetch("/workflow/checks", token, {
    method: "POST",
    body: JSON.stringify(values),
  });
  if (!ok || !body.data) {
    throw new Error(String(body.message || body.error || "AWS check create failed"));
  }
  const check = body.data as Record<string, unknown>;
  return {
    check,
    imagePrefix: String(body.imagePrefix || `checks/${check.id}/`),
  };
}
