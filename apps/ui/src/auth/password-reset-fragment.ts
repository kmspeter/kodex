const PASSWORD_RESET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

interface FragmentLocation {
  hash: string;
  pathname: string;
  search: string;
}

interface FragmentHistory {
  readonly state: unknown;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

/** Removes a reset secret from the address bar before React or API requests start. */
export function recoverPasswordResetTokenFromLocation(
  location: FragmentLocation,
  history: FragmentHistory,
): string | null {
  if (!location.hash.startsWith('#password-reset=')) return null;
  const token = location.hash.slice('#password-reset='.length);
  history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  return PASSWORD_RESET_TOKEN_PATTERN.test(token) ? token : null;
}
