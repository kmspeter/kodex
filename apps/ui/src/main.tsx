import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { recoverInvitationTokenFromLocation } from './auth/invitation-fragment';
import './styles.css';

const invitationToken = recoverInvitationTokenFromLocation(window.location, window.history);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App invitationToken={invitationToken} />
  </StrictMode>,
);
