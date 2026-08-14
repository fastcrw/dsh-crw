/**
 * fastCRW-backed providers for the DeepSeek Harness web capability seam (`ctx.web`).
 *
 * Search maps `POST /v1/search` onto `WebSearchResult`; fetch maps `POST /v1/scrape`
 * onto `WebFetchResult`. Both are implementations only: they register into the seam
 * and never own a model-facing tool (that stays `@deepseek-ai/dsh-tool-web`).
 *
 * @module dsh-crw/providers
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'

/** Stable id both providers register under, for `searchProvider` / `fetchProvider`. */
export const CRW_PROVIDER_ID = 'crw'

/** Default endpoint base; `/v1/search` and `/v1/scrape` are appended. */
export const CRW_DEFAULT_BASE_URL = 'https://fastcrw.com/api'

/** Default cap on decoded body characters, matching the in-box HTTP fetch provider. */
export const CRW_DEFAULT_MAX_BODY_CHARS = 100_000

/** Attribution header sent on every request. */
const USER_AGENT = 'dsh-crw'

/** Resolved options shared by both providers (`apply` supplies the defaults). */
export interface CrwProviderOptions {
  /** fastCRW API key. Required against the cloud endpoint, optional when self-hosting. */
  apiKey: string
  /** Endpoint base; the `/v1/...` operation path is appended. */
  baseURL: string
}

/** Options for the search provider. */
export interface CrwSearchProviderOptions extends CrwProviderOptions {
  /**
   * Ask fastCRW to synthesize an answer over the results and return it as the
   * seam's `content`. Costs an LLM call per search on top of the search credit,
   * so it is opt-in.
   */
  answer: boolean
}

/** Options for the fetch provider. */
export interface CrwFetchProviderOptions extends CrwProviderOptions {
  /** Maximum decoded body characters; a longer body is cut and flagged `truncated`. */
  maxBodyChars: number
}

/** One entry of `/v1/search`'s `data[]`. */
interface CrwSearchItem {
  url?: string
  title?: string
  description?: string
  snippet?: string
}

/** The `/v1/search` response envelope. */
interface CrwSearchResponse {
  success?: boolean
  error?: string
  data?: CrwSearchItem[]
  answer?: string
}

/** The `/v1/scrape` response envelope. */
interface CrwScrapeResponse {
  success?: boolean
  error?: string
  data?: {
    markdown?: string
    metadata?: {
      sourceURL?: string
      statusCode?: number
    }
  }
}

/**
 * Map one fastCRW result to a normalized source. `description` backs `snippet`
 * when the result carries no distinct snippet; a result without a URL is dropped
 * because the seam requires one.
 *
 * @param item - one entry of fastCRW's `data[]`.
 * @returns the normalized source, or `undefined` when the entry has no URL.
 */
export function mapSearchItem(item: CrwSearchItem): WebSearchSource | undefined {
  const url = item.url
  if (url === undefined || url.length === 0) return undefined
  const snippet = firstNonBlank(item.snippet, item.description)
  const title = firstNonBlank(item.title)
  return {
    url,
    ...title !== undefined ? { title } : {},
    ...snippet !== undefined ? { snippet } : {},
  }
}

/**
 * Map a `/v1/search` envelope to a normalized search result. `answer` becomes the
 * seam's optional generated `content`; the seam owns the final `maxResults`
 * truncation, so this reports `truncated: false`.
 *
 * @param response - the parsed `/v1/search` body.
 * @returns the normalized result.
 */
export function mapSearchResponse(response: CrwSearchResponse): WebSearchResult {
  const sources = (response.data ?? [])
    .map(mapSearchItem)
    .filter((source): source is WebSearchSource => source !== undefined)
  const content = firstNonBlank(response.answer)
  return { ...content !== undefined ? { content } : {}, sources, truncated: false }
}

/**
 * Map a `/v1/scrape` envelope to a normalized fetch result.
 *
 * fastCRW reports a non-2xx target as `success: false` while still returning the
 * page it did get. The seam's contract is the opposite way round: a non-2xx
 * response is a RESULT carrying the status code, and an error is reserved for
 * failing to retrieve the resource at all. So an envelope that carries a status
 * code is always a result, whatever `success` says.
 *
 * @param response - the parsed `/v1/scrape` body.
 * @param requestUrl - the requested URL, used when the response names no final URL.
 * @param maxBodyChars - cap on returned body characters.
 * @returns the normalized result, or `undefined` when the envelope carries no status
 *   code and must be treated as a provider error.
 */
export function mapScrapeResponse(
  response: CrwScrapeResponse,
  requestUrl: string,
  maxBodyChars: number,
): WebFetchResult | undefined {
  const statusCode = response.data?.metadata?.statusCode
  if (typeof statusCode !== 'number') return undefined
  const markdown = response.data?.markdown ?? ''
  const content = markdown.slice(0, maxBodyChars)
  return {
    url: firstNonBlank(response.data?.metadata?.sourceURL) ?? requestUrl,
    statusCode,
    // fastCRW already returns markdown, so this is `text`: `html` would send it
    // back through the tool's turndown pass and convert converted output.
    body: { kind: 'text', content },
    truncated: content.length !== markdown.length,
  }
}

/** A `WebSearchProvider` backed by fastCRW's `/v1/search`. */
export class CrwSearchProvider implements WebSearchProvider {
  readonly id = CRW_PROVIDER_ID

  constructor(private readonly options: CrwSearchProviderOptions) {}

  available(): boolean {
    return isUsableEndpoint(this.options)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const payload = await call<CrwSearchResponse>(this.options, '/v1/search', {
      query: request.query,
      ...request.maxResults !== undefined ? { limit: request.maxResults } : {},
      // Answer synthesis reads the results, which requires markdown to be scraped.
      ...this.options.answer ? { answer: true, scrapeOptions: { formats: ['markdown'] } } : {},
    }, signal)
    if (payload.success === false) {
      throw new WebError(errorMessage(payload.error, 'fastCRW search failed'), 'WEB_PROVIDER_ERROR')
    }
    return mapSearchResponse(payload)
  }
}

/** A `WebFetchProvider` backed by fastCRW's `/v1/scrape`. */
export class CrwFetchProvider implements WebFetchProvider {
  readonly id = CRW_PROVIDER_ID

  constructor(private readonly options: CrwFetchProviderOptions) {}

  available(): boolean {
    return isUsableEndpoint(this.options) && isPositiveInteger(this.options.maxBodyChars)
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    // No renderer hint: fastCRW's own escalation ladder decides per page whether
    // plain HTTP is enough or a browser tier is needed.
    const payload = await call<CrwScrapeResponse>(this.options, '/v1/scrape', {
      url: request.url,
      formats: ['markdown'],
    }, signal)
    const result = mapScrapeResponse(payload, request.url, this.options.maxBodyChars)
    if (result === undefined) {
      throw new WebError(errorMessage(payload.error, 'fastCRW could not retrieve the URL'), 'WEB_PROVIDER_ERROR')
    }
    return result
  }
}

/**
 * POST one JSON body to a fastCRW operation and parse the JSON response.
 *
 * A non-2xx from fastCRW itself (a rejected URL, a bad key, an exhausted balance)
 * is a provider error: it means the operation never ran. The per-target status
 * code lives inside a 2xx envelope instead, and callers map it there.
 *
 * @param options - endpoint and credential.
 * @param path - the operation path appended to `baseURL`.
 * @param body - the request body.
 * @param signal - optional cancellation signal.
 * @returns the parsed response body.
 */
async function call<T>(
  options: CrwProviderOptions,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${options.baseURL}${path}`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json',
        'user-agent': USER_AGENT,
        ...options.apiKey.length > 0 ? { authorization: `Bearer ${options.apiKey}` } : {},
      },
      body: JSON.stringify(body),
      ...signal !== undefined ? { signal } : {},
    })
  } catch (error: unknown) {
    if (isAbortError(error)) throw new WebError('fastCRW request aborted', 'WEB_ABORTED', { cause: error })
    throw new WebError(`fastCRW request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }

  let payload: T
  try {
    payload = await response.json() as T
  } catch (error: unknown) {
    if (isAbortError(error)) throw new WebError('fastCRW request aborted', 'WEB_ABORTED', { cause: error })
    if (!response.ok) {
      throw new WebError(`fastCRW API error (HTTP ${response.status})`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    throw new WebError(`fastCRW returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }

  if (!response.ok) {
    const detail = (payload as { error?: string } | null)?.error
    throw new WebError(errorMessage(detail, `fastCRW API error (HTTP ${response.status})`), 'WEB_PROVIDER_ERROR')
  }
  return payload
}

/** The first argument that is a non-blank string, or `undefined`. */
function firstNonBlank(...values: (string | undefined)[]): string | undefined {
  return values.find(value => value !== undefined && value.trim().length > 0)
}

/** A provider-supplied message when it carries one, else the given fallback. */
function errorMessage(detail: string | undefined, fallback: string): string {
  return firstNonBlank(detail) ?? fallback
}

/**
 * A cheap local usability check: the base URL must parse, and the cloud endpoint
 * additionally needs a key. A self-hosted `crw serve` takes no credential, so
 * requiring one unconditionally would make self-hosting unreachable.
 */
function isUsableEndpoint(options: CrwProviderOptions): boolean {
  if (!URL.canParse(options.baseURL)) return false
  return options.apiKey.length > 0 || options.baseURL !== CRW_DEFAULT_BASE_URL
}

/** True for a positive whole number. */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
