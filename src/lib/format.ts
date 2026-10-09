export function money(value: number): string {
  return `NT$${new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 }).format(Math.round(value))}`;
}

/** Display a canonical TWD integer without losing precision through Number. */
export function integerTwd(value: bigint): string {
  return `NT$${new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 }).format(value)}`;
}
