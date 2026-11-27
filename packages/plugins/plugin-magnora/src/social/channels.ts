import type { SocialChannelConfig, SocialChannelKey } from "../config.js";
import { IntegrationError, requestJson, requestOk, type FetchFn } from "../http.js";

export interface SocialPost {
  text: string;
  link?: string | null;
  imageUrl?: string | null;
}

export interface PublishResult {
  externalId: string;
  url: string | null;
}

export type ChannelStatus = "connected" | "not_configured" | "disabled" | "error" | "expired";

/**
 * A modular social channel. Each implementation uses only the provider's
 * official API with a token from the Paperclip secrets vault.
 */
export interface SocialChannel {
  readonly key: SocialChannelKey;
  readonly displayName: string;
  readonly maxLength: number;
  configuredStatus(): ChannelStatus;
  validate(post: SocialPost): string | null;
  testConnection(token: string): Promise<string>;
  publish(post: SocialPost, token: string): Promise<PublishResult>;
}

abstract class BaseChannel implements SocialChannel {
  abstract readonly key: SocialChannelKey;
  abstract readonly displayName: string;
  abstract readonly maxLength: number;
  protected readonly requiresAccountId: boolean = true;

  constructor(protected readonly config: SocialChannelConfig, protected readonly fetchFn: FetchFn) {}

  configuredStatus(): ChannelStatus {
    if (!this.config.enabled) return "disabled";
    if (!this.config.accessToken) return "not_configured";
    if (this.requiresAccountId && !this.config.accountId) return "not_configured";
    return "connected";
  }

  validate(post: SocialPost): string | null {
    if (!post.text.trim()) return "Post text is empty";
    if (post.text.length > this.maxLength) return `${this.displayName} allows at most ${this.maxLength} characters (got ${post.text.length})`;
    return null;
  }

  abstract testConnection(token: string): Promise<string>;
  abstract publish(post: SocialPost, token: string): Promise<PublishResult>;
}

/** Facebook Page posts via the Graph API Page feed / photos edges. */
export class FacebookChannel extends BaseChannel {
  readonly key = "facebook" as const;
  readonly displayName = "Facebook";
  readonly maxLength = 63_206;

  private base() {
    return `https://graph.facebook.com/${encodeURIComponent(this.config.apiVersion)}/${encodeURIComponent(this.config.accountId)}`;
  }

  async testConnection(token: string) {
    const page = await requestJson<{ name?: string }>(this.fetchFn, `${this.base()}?fields=id,name`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return `Page: ${page.name ?? this.config.accountId}`;
  }

  async publish(post: SocialPost, token: string): Promise<PublishResult> {
    const body = new URLSearchParams();
    let edge = "feed";
    if (post.imageUrl) {
      edge = "photos";
      body.set("url", post.imageUrl);
      body.set("caption", post.link ? `${post.text}\n\n${post.link}` : post.text);
    } else {
      body.set("message", post.text);
      if (post.link) body.set("link", post.link);
    }
    const result = await requestJson<{ id?: string; post_id?: string }>(this.fetchFn, `${this.base()}/${edge}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
      body,
      retries: 0,
    });
    const id = result.post_id ?? result.id;
    if (!id) throw new IntegrationError("upstream", "Facebook did not return a post id");
    return { externalId: id, url: `https://www.facebook.com/${id}` };
  }
}

/** Instagram business publishing: create a media container, then publish it. */
export class InstagramChannel extends BaseChannel {
  readonly key = "instagram" as const;
  readonly displayName = "Instagram";
  readonly maxLength = 2_200;

  private base() {
    return `https://graph.facebook.com/${encodeURIComponent(this.config.apiVersion)}/${encodeURIComponent(this.config.accountId)}`;
  }

  validate(post: SocialPost) {
    if (!post.imageUrl) return "Instagram posts require a public imageUrl";
    return super.validate(post);
  }

  async testConnection(token: string) {
    const user = await requestJson<{ username?: string }>(this.fetchFn, `${this.base()}?fields=id,username`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return `Account: ${user.username ?? this.config.accountId}`;
  }

  async publish(post: SocialPost, token: string): Promise<PublishResult> {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" };
    const container = await requestJson<{ id?: string }>(this.fetchFn, `${this.base()}/media`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ image_url: post.imageUrl ?? "", caption: post.text }),
      retries: 0,
    });
    if (!container.id) throw new IntegrationError("upstream", "Instagram did not return a media container id");
    const published = await requestJson<{ id?: string }>(this.fetchFn, `${this.base()}/media_publish`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ creation_id: container.id }),
      retries: 0,
    });
    if (!published.id) throw new IntegrationError("upstream", "Instagram did not return a published media id");
    return { externalId: published.id, url: null };
  }
}

/** LinkedIn Posts API (versioned REST). */
export class LinkedInChannel extends BaseChannel {
  readonly key = "linkedin" as const;
  readonly displayName = "LinkedIn";
  readonly maxLength = 3_000;

  private headers(token: string) {
    return {
      authorization: `Bearer ${token}`,
      "linkedin-version": this.config.apiVersion,
      "x-restli-protocol-version": "2.0.0",
      "content-type": "application/json",
    };
  }

  async testConnection(token: string) {
    const url = `https://api.linkedin.com/rest/posts?q=author&author=${encodeURIComponent(this.config.accountId)}&count=1`;
    await requestOk(this.fetchFn, url, { headers: this.headers(token) });
    return `Author: ${this.config.accountId}`;
  }

  async publish(post: SocialPost, token: string): Promise<PublishResult> {
    const body: Record<string, unknown> = {
      author: this.config.accountId,
      commentary: post.text,
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };
    if (post.link) body.content = { article: { source: post.link, title: post.link } };
    const response = await requestOk(this.fetchFn, "https://api.linkedin.com/rest/posts", {
      method: "POST",
      headers: this.headers(token),
      body: JSON.stringify(body),
      retries: 0,
    });
    const id = response.headers.get("x-restli-id") ?? response.headers.get("x-linkedin-id");
    if (!id) throw new IntegrationError("upstream", "LinkedIn did not return a post URN");
    return { externalId: id, url: `https://www.linkedin.com/feed/update/${id}/` };
  }
}

/** X (Twitter) API v2 with an OAuth 2.0 user-context token (tweet.write). */
export class XChannel extends BaseChannel {
  readonly key = "x" as const;
  readonly displayName = "X / Twitter";
  readonly maxLength = 280;
  protected readonly requiresAccountId = false;

  async testConnection(token: string) {
    const me = await requestJson<{ data?: { username?: string } }>(this.fetchFn, "https://api.x.com/2/users/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    return `User: @${me.data?.username ?? "unknown"}`;
  }

  validate(post: SocialPost) {
    return super.validate({ ...post, text: post.link ? `${post.text} ${post.link}` : post.text });
  }

  async publish(post: SocialPost, token: string): Promise<PublishResult> {
    const text = post.link ? `${post.text} ${post.link}` : post.text;
    const result = await requestJson<{ data?: { id?: string } }>(this.fetchFn, "https://api.x.com/2/tweets", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ text }),
      retries: 0,
    });
    const id = result.data?.id;
    if (!id) throw new IntegrationError("upstream", "X did not return a post id");
    return { externalId: id, url: `https://x.com/i/web/status/${id}` };
  }
}

export function createChannel(key: SocialChannelKey, config: SocialChannelConfig, fetchFn: FetchFn): SocialChannel {
  switch (key) {
    case "facebook":
      return new FacebookChannel(config, fetchFn);
    case "instagram":
      return new InstagramChannel(config, fetchFn);
    case "linkedin":
      return new LinkedInChannel(config, fetchFn);
    case "x":
      return new XChannel(config, fetchFn);
  }
}
