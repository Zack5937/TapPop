import { checkSettlement, type PendingPayment, type Settlement } from './payments';

// One in-flight query per watcher. Foreground refreshes must not multiply polling
// loops, and responses arriving after cleanup must not update the next payment.
export function watchSettlement(
  payment: PendingPayment,
  onResult: (settlement: Settlement) => void,
  onError: (error: unknown) => void,
  query: typeof checkSettlement = checkSettlement,
  intervalMs = 5000,
) {
  let stopped = false;
  let checking = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function checkNow() {
    if (stopped || checking) return;
    clearTimeout(timer);
    checking = true;
    try {
      const result = await query(payment);
      if (stopped) return;
      if (result !== 'pending') stopped = true;
      onResult(result);
    } catch (error) {
      if (!stopped) onError(error);
    } finally {
      checking = false;
      if (!stopped) timer = setTimeout(() => void checkNow(), intervalMs);
    }
  }

  void checkNow();
  return {
    checkNow,
    stop() { stopped = true; clearTimeout(timer); },
  };
}
