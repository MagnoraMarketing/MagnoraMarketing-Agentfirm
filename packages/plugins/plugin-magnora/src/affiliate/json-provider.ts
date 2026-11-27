import type { JsonAffiliateProviderConfig } from "../config.js";
import { IntegrationError, readPath, requestJson, toNumber, type FetchFn } from "../http.js";
import type { DateRange } from "../periods.js";
import { BaseAffiliateProvider, withConversionRate, type AffiliateStats, type AffiliateStatus } from "./types.js";

/**
 * Generic provider for affiliate networks that expose an official JSON
 * reporting endpoint authenticated with a token. The operator supplies the
 * documented report URL and the field names; nothing here guesses endpoints.
 * Rows are summed, so both "one row per day" and "one row per advertiser"
 * report shapes work.
 */
export class JsonAffiliateProvider extends BaseAffiliateProvider {
  readonly key: string;
  readonly displayName: string;

  constructor(
    private readonly config: JsonAffiliateProviderConfig,
    private readonly fetchFn: FetchFn,
    private readonly resolveToken: () => Promise<string | null>,
  ) {
    super();
    this.key = config.key;
    this.displayName = config.displayName;
  }

  status(): AffiliateStatus {
    if (!this.config.enabled || !this.config.statsUrl || !this.config.apiToken) return "not_configured";
    return "connected";
  }

  buildUrl(range: DateRange): string {
    const url = this.config.statsUrl
      .replaceAll("{startDate}", encodeURIComponent(range.startDate))
      .replaceAll("{endDate}", encodeURIComponent(range.endDate));
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new IntegrationError("invalid_request", "Affiliate report URL must use https");
    return parsed.toString();
  }

  async getStats(range: DateRange): Promise<AffiliateStats> {
    if (this.status() === "not_configured") {
      throw new IntegrationError("not_configured", `${this.displayName}: missing report URL or API token`);
    }
    const token = await this.resolveToken();
    if (!token) throw new IntegrationError("not_configured", `${this.displayName}: API token secret is empty`);
    const body = await requestJson(this.fetchFn, this.buildUrl(range), {
      method: "GET",
      headers: { accept: "application/json", [this.config.authHeader]: `${this.config.authPrefix}${token}` },
    });
    const rowsValue = readPath(body, this.config.rowsPath);
    const rows = Array.isArray(rowsValue) ? rowsValue : rowsValue && typeof rowsValue === "object" ? [rowsValue] : [];
    const sum = (field: string) => (field ? rows.reduce<number>((total, row) => total + toNumber(readPath(row, field)), 0) : 0);
    const f = this.config.fields;
    return withConversionRate({
      clicks: sum(f.clicks),
      leads: sum(f.leads),
      conversions: sum(f.conversions),
      sales: sum(f.sales),
      commission: sum(f.commission),
      payouts: sum(f.payouts),
      currency: this.config.currency,
    });
  }
}
