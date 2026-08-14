/**
 * `dsh-crw`: registers fastCRW-backed search and fetch providers with `ctx.web`.
 *
 * A function/namespace plugin (NOT a default-export service): providers do not own
 * the `ctx.web` key, they register INTO the seam's registries. The key is owned by
 * `@deepseek-ai/dsh-web`, and the model-facing `web_search` / `web_fetch` tools stay
 * owned by `@deepseek-ai/dsh-tool-web`.
 *
 * Both providers register under the id `crw`, so a composition that also mounts
 * another provider selects with `web.searchProvider` / `web.fetchProvider`.
 *
 * @module dsh-crw
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  CRW_DEFAULT_BASE_URL,
  CRW_DEFAULT_MAX_BODY_CHARS,
  CrwFetchProvider,
  CrwSearchProvider,
} from './providers.ts'

export {
  CRW_DEFAULT_BASE_URL,
  CRW_DEFAULT_MAX_BODY_CHARS,
  CRW_PROVIDER_ID,
  CrwFetchProvider,
  CrwSearchProvider,
  mapScrapeResponse,
  mapSearchItem,
  mapSearchResponse,
} from './providers.ts'
export type {
  CrwFetchProviderOptions,
  CrwProviderOptions,
  CrwSearchProviderOptions,
} from './providers.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'crw'

/** The web seam these providers register into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /**
   * fastCRW API key. Falls back to `$CRW_API_KEY`. Required against the cloud
   * endpoint; a self-hosted `crw serve` needs no credential.
   */
  apiKey?: string
  /** Endpoint base; `/v1/search` and `/v1/scrape` are appended. Defaults to the cloud API. */
  baseURL?: string
  /** Register the search provider. Defaults to true. */
  search?: boolean
  /** Register the fetch provider. Defaults to true. */
  fetch?: boolean
  /**
   * Ask fastCRW to synthesize an answer over the search results, returned as the
   * seam's `content`. Off by default: it adds an LLM call per search.
   */
  answer?: boolean
  /** Cap on returned page characters. Defaults to 100000, matching the in-box HTTP provider. */
  maxBodyChars?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string(),
  baseURL: z.string(),
  search: z.boolean(),
  fetch: z.boolean(),
  answer: z.boolean(),
  maxBodyChars: z.number().step(1).min(1),
})

/** Register the fastCRW providers with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  const shared = {
    apiKey: config.apiKey ?? process.env.CRW_API_KEY ?? '',
    baseURL: config.baseURL ?? CRW_DEFAULT_BASE_URL,
  }
  if (config.search !== false) {
    ctx.web.registerSearchProvider(new CrwSearchProvider({
      ...shared,
      answer: config.answer ?? false,
    }))
  }
  if (config.fetch !== false) {
    ctx.web.registerFetchProvider(new CrwFetchProvider({
      ...shared,
      maxBodyChars: config.maxBodyChars ?? CRW_DEFAULT_MAX_BODY_CHARS,
    }))
  }
}
