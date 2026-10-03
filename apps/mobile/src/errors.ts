// MWA's public error codes. Keep this formatter free of native imports so it
// also handles bridge errors (plain objects) and can be tested outside Android.
export function paymentErrorMessage(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'ERROR_WALLET_NOT_FOUND':
      return 'No compatible wallet found. Install a Mobile Wallet Adapter wallet on this Android device and select Devnet.';
    case 'ERROR_ASSOCIATION_CANCELLED':
    case 'Session not established: Local association cancelled by user':
    case -3:
      return 'Request cancelled in your wallet. You can review the payment and try again.';
    case 'ERROR_SESSION_TIMEOUT':
      return 'Wallet connection timed out. Unlock your wallet and try again. If a payment is pending, check its status first.';
    case -1:
      return 'Wallet authorization was declined or expired. Reconnect your wallet to continue.';
    default:
      return error instanceof Error ? error.message : 'Could not complete the request. Try again after checking any pending payment.';
  }
}
