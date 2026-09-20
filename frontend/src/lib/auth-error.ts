export function authErrorMessage(code: string | null): string | null {
  switch (code) {
    case "access_denied":
      return "Google sign-in was canceled. Try again or sign in with email.";
    case "callback_failed":
    case "missing_code":
      return "We couldn't complete your sign-in. Please try again in the same browser or request a new email link.";
    default:
      return null;
  }
}
