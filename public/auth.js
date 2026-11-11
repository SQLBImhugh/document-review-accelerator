window.msalRedirectBridge.broadcastResponseToMainFrame().catch(() => {
  document.body.textContent = 'Sign-in could not return to the workbench. Close this window and try signing in again.';
});
