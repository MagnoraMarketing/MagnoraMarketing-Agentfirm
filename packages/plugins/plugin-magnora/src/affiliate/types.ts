import type { DateRange } from "../periods.js";

export interface AffiliateStats {
  clicks: number;
  leads: number;
  conversions: number;
  sales: number;
  commission: number;
  payouts: number;
  /** conversions / clicks, 0..1 (0 when there are no clicks). */
  conversionRate: number;
  currency: string;
}

export type AffiliateStatus = "connected" | "not_configured" | "error" | "expired";

/**
 * Contract every affiliate network integration implements. Providers are
 * read-only: nothing in this interface can change an affiliate account.
 * A provider must only call the network's official, documented API.
 */
export interface AffiliateProvider {
  readonly key: string;
  readonly displayName: string;
  status(): AffiliateStatus;
  getStats(range: DateRange): Promise<AffiliateStats>;
  getClicks(range: DateRange): Promise<number>;
  getLeads(range: DateRange): Promise<number>;
  getConversions(range: DateRange): Promise<number>;
  getCommission(range: DateRange): Promise<number>;
  getPayouts(range: DateRange): Promise<number>;
  testConnection(): Promise<{ ok: boolean; message: string }>;
}

export function emptyStats(currency: string): AffiliateStats {
  return { clicks: 0, leads: 0, conversions: 0, sales: 0, commission: 0, payouts: 0, conversionRate: 0, currency };
}

export function withConversionRate(stats: Omit<AffiliateStats, "conversionRate">): AffiliateStats {
  return { ...stats, conversionRate: stats.clicks > 0 ? stats.conversions / stats.clicks : 0 };
}

/** Base class so concrete providers only implement getStats(). */
export abstract class BaseAffiliateProvider implements AffiliateProvider {
  abstract readonly key: string;
  abstract readonly displayName: string;
  abstract status(): AffiliateStatus;
  abstract getStats(range: DateRange): Promise<AffiliateStats>;

  async getClicks(range: DateRange) {
    return (await this.getStats(range)).clicks;
  }
  async getLeads(range: DateRange) {
    return (await this.getStats(range)).leads;
  }
  async getConversions(range: DateRange) {
    return (await this.getStats(range)).conversions;
  }
  async getCommission(range: DateRange) {
    return (await this.getStats(range)).commission;
  }
  async getPayouts(range: DateRange) {
    return (await this.getStats(range)).payouts;
  }
  async testConnection() {
    if (this.status() === "not_configured") return { ok: false, message: "Not configured" };
    const today = new Date().toISOString().slice(0, 10);
    await this.getStats({ startDate: today, endDate: today });
    return { ok: true, message: "Connected" };
  }
}
