if (!location.hash && !location.search) {
  location.replace(location.origin);
} else {
  window.msalRedirectBridge.broadcastResponseToMainFrame().catch(() => {
    document.body.textContent = 'Microsoft sign-in or sign-out could not return to the workbench. Close this window and try again.';
  });
}
