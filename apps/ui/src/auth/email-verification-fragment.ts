// A 32-byte unpadded base64url value is 43 characters and its final sextet can
// contain only the two remaining data bits.
const EMAIL_VERIFICATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{42}[AQgw]$/u;

interface FragmentLocation {
  hash: string;
  pathname: string;
  search: string;
}

interface FragmentHistory {
  readonly state: unknown;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

/** Removes the verification secret before React or an API client can start. */
export function recoverEmailVerificationTokenFromLocation(
  location: FragmentLocation,
  history: FragmentHistory,
): string | null {
  if (!location.hash.startsWith('#email-verification=')) return null;
  const token = location.hash.slice('#email-verification='.length);
  history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  return EMAIL_VERIFICATION_TOKEN_PATTERN.test(token) ? token : null;
}
