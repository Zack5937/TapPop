declare module 'qrcode/lib/core/qrcode' {
  export function create(text: string, options?: { errorCorrectionLevel: 'M' }): {
    modules: { size: number; get(row: number, column: number): number };
  };
}
