/**
 * currency-service — multi-currency support.
 *
 * Supports common Asian travel currencies: TWD, USD, JPY, EUR, KRW, THB.
 * Exchange rates are fetched from a free API (open.er-api.com) and
 * cached for 24 hours.
 *
 * `convertToTwd(amount, currency)` returns the TWD equivalent.
 */

const SUPPORTED_CURRENCIES = ["TWD", "USD", "JPY", "EUR", "KRW", "THB"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FALLBACK_RATES: Record<Currency, number> = {
  TWD: 1,
  USD: 32,
  JPY: 0.21,
  EUR: 34,
  KRW: 0.024,
  THB: 0.93,
};

let cachedRates: Record<Currency, number> | null = null;
let cachedAt = 0;

export function isSupportedCurrency(code: string): code is Currency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(code.toUpperCase());
}

export async function fetchRates(): Promise<Record<Currency, number>> {
  if (cachedRates && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedRates;
  }

  try {
    const response = await fetch("https://open.er-api.com/v6/latest/TWD", {
      cache: "no-store",
    });
    if (!response.ok) throw new Error("rate fetch failed");
    const data = await response.json();
    const apiRates = data.rates as Record<string, number>;
    if (!apiRates) throw new Error("no rates in response");

    const rates: Record<Currency, number> = { ...FALLBACK_RATES };
    for (const code of SUPPORTED_CURRENCIES) {
      if (code === "TWD") {
        rates.TWD = 1;
      } else if (apiRates[code]) {
        rates[code] = 1 / apiRates[code];
      }
    }

    cachedRates = rates;
    cachedAt = Date.now();
    return rates;
  } catch {
    cachedRates = FALLBACK_RATES;
    cachedAt = Date.now();
    return FALLBACK_RATES;
  }
}

export async function convertToTwd(
  amount: number,
  currency: Currency,
): Promise<{ twdAmount: number; rate: number }> {
  if (currency === "TWD") {
    return { twdAmount: Math.round(amount), rate: 1 };
  }

  const rates = await fetchRates();
  const rate = rates[currency] ?? FALLBACK_RATES[currency];
  return {
    twdAmount: Math.round(amount * rate),
    rate,
  };
}

export function detectCurrency(text: string): Currency | null {
  const lower = text.toLowerCase();

  if (/(¥|日元|日圓|jpy)/i.test(lower)) return "JPY";
  if (/(¥|¥\d)/.test(text) && !/rmb|cny/i.test(lower)) return "JPY";
  if (/(usd|美金|美元|\$)/i.test(lower)) return "USD";
  if (/(eur|歐元|€)/i.test(lower)) return "EUR";
  if (/(krw|韓元|韓圜|₩)/i.test(lower)) return "KRW";
  if (/(thb|泰銖|฿)/i.test(lower)) return "THB";

  return null;
}

export function parseCurrencyAmount(text: string): {
  amount: number | null;
  currency: Currency | null;
} {
  const currency = detectCurrency(text);
  const amountMatch = text.match(/(\d[\d,]*)/);
  if (!amountMatch) return { amount: null, currency };
  const amount = Number(amountMatch[1].replace(/,/g, ""));
  return { amount: isNaN(amount) ? null : amount, currency };
}
