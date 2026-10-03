export function authErrorMessage(code: string | null): string | null {
  switch (code) {
    case "access_denied":
      return "Your sign-in was canceled or the link has expired. Try again or request a new email link.";
    case "callback_failed":
    case "missing_code":
      return "We couldn't complete your sign-in. Please try again in the same browser or request a new email link.";
    default:
      return null;
  }
}
