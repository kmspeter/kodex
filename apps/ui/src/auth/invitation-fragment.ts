const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

interface FragmentLocation {
  hash: string;
  origin: string;
  pathname: string;
  search: string;
}

interface FragmentHistory {
  readonly state: unknown;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

/** Removes an invite fragment before React starts and returns only a canonical 256-bit token. */
export function recoverInvitationTokenFromLocation(
  location: FragmentLocation,
  history: FragmentHistory,
): string | null {
  if (!location.hash.startsWith('#invite=')) return null;
  const token = location.hash.slice('#invite='.length);
  history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  return INVITATION_TOKEN_PATTERN.test(token) ? token : null;
}

export function createInvitationShareLink(origin: string, token: string): string {
  const url = new URL(origin);
  if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || !INVITATION_TOKEN_PATTERN.test(token)) {
    throw new Error('Invitation link input is invalid.');
  }
  return `${url.origin}/#invite=${token}`;
}
