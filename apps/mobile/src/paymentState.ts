import type { PendingPayment, Settlement } from './payments';

export type PaymentState = { payment: PendingPayment | null; settlement: Settlement };
export type PaymentEvent =
  | { type: 'restore' | 'save'; payment: PendingPayment | null }
  | { type: 'status'; signature: string; settlement: Settlement }
  | { type: 'clear'; signature: string };

export const initialPaymentState: PaymentState = { payment: null, settlement: 'pending' };

export function paymentReducer(state: PaymentState, event: PaymentEvent): PaymentState {
  if (event.type === 'restore' || event.type === 'save') {
    return { payment: event.payment, settlement: 'pending' };
  }
  if (!('signature' in event) || state.payment?.signature !== event.signature) return state;
  if (event.type === 'clear') {
    return state.settlement === 'pending' ? state : initialPaymentState;
  }
  // Late polling/manual responses cannot downgrade a resolved payment or update
  // another payment that has since replaced it.
  if (state.settlement !== 'pending') return state;
  return { ...state, settlement: event.settlement };
}
