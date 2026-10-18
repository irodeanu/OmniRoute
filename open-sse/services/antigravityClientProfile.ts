import {
  DEFAULT_ANTIGRAVITY_CLIENT_PROFILE,
  normalizeAntigravityClientProfile,
  type AntigravityClientProfile,
} from "@/shared/constants/antigravityClientProfile";
import { getAntigravityContentHeaders } from "./antigravityHeaders.ts";
import type { AntigravityCredentialsLike } from "./antigravityIdentity.ts";
import {
  resolveAntigravityCliVersion,
  resolveAntigravityIdeVersion,
} from "./antigravityVersion.ts";

export {
  ANTIGRAVITY_CLIENT_PROFILE_VALUES,
  DEFAULT_ANTIGRAVITY_CLIENT_PROFILE,
  normalizeAntigravityClientProfile,
  type AntigravityClientProfile,
} from "@/shared/constants/antigravityClientProfile";

type AntigravityProfileCredentials = AntigravityCredentialsLike & {
  providerSpecificData?: Record<string, unknown> | null;
};

const ABSENT_CONTENT_IDENTITY_HEADERS = [
  "x-client-name",
  "x-client-version",
  "x-machine-id",
  "x-vscode-sessionid",
  "X-Goog-Api-Client",
  "Client-Metadata",
] as const;

export function getAntigravityClientProfile(
  credentials?: AntigravityProfileCredentials | null
): AntigravityClientProfile {
  const fromProviderData =
    credentials?.providerSpecificData &&
    typeof credentials.providerSpecificData === "object" &&
    !Array.isArray(credentials.providerSpecificData)
      ? credentials.providerSpecificData.clientProfile
      : undefined;

  return normalizeAntigravityClientProfile(fromProviderData);
}

export function resolveAntigravityClientVersion(
  profile: AntigravityClientProfile
): Promise<string> {
  return profile === "cli" ? resolveAntigravityCliVersion() : resolveAntigravityIdeVersion();
}

export function removeHeaderCaseInsensitive(headers: Record<string, string>, name: string): void {
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) {
      delete headers[key];
    }
  }
}

/** Apply the selected official client identity to a Cloud Code content request. */
export function applyAntigravityClientProfileHeaders(
  headers: Record<string, string>,
  credentials: AntigravityProfileCredentials | null | undefined,
  _body?: unknown
): AntigravityClientProfile {
  const profile = getAntigravityClientProfile(credentials);
  const identityHeaders = getAntigravityContentHeaders(profile);

  removeHeaderCaseInsensitive(headers, "User-Agent");
  headers["User-Agent"] = identityHeaders["User-Agent"];
  for (const name of ABSENT_CONTENT_IDENTITY_HEADERS) {
    removeHeaderCaseInsensitive(headers, name);
  }

  // Never send `x-goog-user-project`. The official Antigravity IDE/CLI carry the
  // Cloud Code project only in the envelope body (`project`), not as a GCP
  // quota/billing header. Consumer accounts are assigned Google's shared
  // `aicode-consumers` project, on which the caller has no serviceusage role, so
  // the header produced a 403 USER_PROJECT_DENIED on every request and the old
  // retry-without-header fallback doubled every upstream send (a non-client
  // 403->200 signature on each account). Strip any inbound copy as well.
  removeHeaderCaseInsensitive(headers, "x-goog-user-project");

  return profile;
}
