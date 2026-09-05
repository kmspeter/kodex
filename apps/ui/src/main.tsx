import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { recoverInvitationTokenFromLocation } from './auth/invitation-fragment';
import { recoverPasswordResetTokenFromLocation } from './auth/password-reset-fragment';
import { recoverEmailVerificationTokenFromLocation } from './auth/email-verification-fragment';
import './styles.css';

const invitationToken = recoverInvitationTokenFromLocation(window.location, window.history);
const passwordResetToken = recoverPasswordResetTokenFromLocation(window.location, window.history);
const emailVerificationToken = recoverEmailVerificationTokenFromLocation(window.location, window.history);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App
      emailVerificationToken={emailVerificationToken}
      invitationToken={invitationToken}
      passwordResetToken={passwordResetToken}
    />
  </StrictMode>,
);
