import { describe, expect, test } from 'bun:test'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  CRW_DEFAULT_BASE_URL,
  CrwFetchProvider,
  CrwSearchProvider,
  mapScrapeResponse,
  mapSearchResponse,
} from '../src/providers.ts'

/** Run `body` with `fetch` stubbed, restoring the real one afterwards. */
async function withFetch(stub: typeof fetch, body: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch
  globalThis.fetch = stub
  try {
    await body()
  } finally {
    globalThis.fetch = real
  }
}

/** A stub returning one JSON body at a given status. */
function jsonOnce(status: number, payload: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch
}

const searchOptions = { apiKey: 'k', baseURL: CRW_DEFAULT_BASE_URL, answer: false }
const fetchOptions = { apiKey: 'k', baseURL: CRW_DEFAULT_BASE_URL, maxBodyChars: 100 }

describe('search mapping', () => {
  test('maps results and falls back from snippet to description', () => {
    const result = mapSearchResponse({
      success: true,
      data: [
        { url: 'https://a.example', title: 'A', snippet: 'snip' },
        { url: 'https://b.example', title: 'B', description: 'desc' },
      ],
    })
    expect(result.sources).toEqual([
      { url: 'https://a.example', title: 'A', snippet: 'snip' },
      { url: 'https://b.example', title: 'B', snippet: 'desc' },
    ])
    expect(result.content).toBeUndefined()
    expect(result.truncated).toBe(false)
  })

  test('drops a result with no URL rather than inventing one', () => {
    const result = mapSearchResponse({ data: [{ title: 'no url' }, { url: 'https://a.example' }] })
    expect(result.sources).toHaveLength(1)
  })

  test('carries a synthesized answer as content', () => {
    expect(mapSearchResponse({ data: [], answer: 'the answer' }).content).toBe('the answer')
  })

  test('ignores a blank answer', () => {
    expect(mapSearchResponse({ data: [], answer: '   ' }).content).toBeUndefined()
  })
})

describe('fetch mapping', () => {
  test('maps a page to a text body at its final URL', () => {
    const result = mapScrapeResponse({
      success: true,
      data: { markdown: '# hi', metadata: { sourceURL: 'https://x.example/final', statusCode: 200 } },
    }, 'https://x.example', 100)
    expect(result).toEqual({
      url: 'https://x.example/final',
      statusCode: 200,
      body: { kind: 'text', content: '# hi' },
      truncated: false,
    })
  })

  test('a non-2xx target is a result, not an error, even when success is false', () => {
    // fastCRW reports a 404 target as success:false while still returning what it
    // got. The seam's contract puts the status code in the result instead.
    const result = mapScrapeResponse({
      success: false,
      error: 'Target returned 404 Not Found',
      data: { markdown: '# gone', metadata: { sourceURL: 'https://x.example/404', statusCode: 404 } },
    }, 'https://x.example/404', 100)
    expect(result?.statusCode).toBe(404)
    expect(result?.body.content).toBe('# gone')
  })

  test('an envelope with no status code is not a result', () => {
    expect(mapScrapeResponse({ success: false, error: 'This URL is not allowed' }, 'http://127.0.0.1', 100))
      .toBeUndefined()
  })

  test('caps the body and flags truncation', () => {
    const result = mapScrapeResponse({
      data: { markdown: 'x'.repeat(150), metadata: { statusCode: 200 } },
    }, 'https://x.example', 100)
    expect(result?.body.content).toHaveLength(100)
    expect(result?.truncated).toBe(true)
  })
})

describe('availability', () => {
  test('the cloud endpoint needs a key', () => {
    expect(new CrwSearchProvider({ ...searchOptions, apiKey: '' }).available()).toBe(false)
    expect(new CrwSearchProvider(searchOptions).available()).toBe(true)
  })

  test('a self-hosted endpoint needs no key', () => {
    expect(new CrwSearchProvider({ ...searchOptions, apiKey: '', baseURL: 'http://localhost:3002' }).available())
      .toBe(true)
  })

  test('an unparseable base URL is unusable', () => {
    expect(new CrwFetchProvider({ ...fetchOptions, baseURL: 'not a url' }).available()).toBe(false)
  })
})

describe('errors', () => {
  test('a rejected URL surfaces the API message', async () => {
    await withFetch(jsonOnce(400, { success: false, error: 'This URL is not allowed' }), async () => {
      const promise = new CrwFetchProvider(fetchOptions).fetch({ url: 'http://127.0.0.1:8080/' })
      await expect(promise).rejects.toThrow('This URL is not allowed')
      await expect(promise).rejects.toBeInstanceOf(WebError)
    })
  })

  test('a failed search envelope is a provider error', async () => {
    await withFetch(jsonOnce(200, { success: false, error: 'upstream unavailable' }), async () => {
      await expect(new CrwSearchProvider(searchOptions).search({ query: 'q' }))
        .rejects.toThrow('upstream unavailable')
    })
  })

  test('an abort surfaces as WEB_ABORTED', async () => {
    const stub = (async () => {
      throw new DOMException('aborted', 'AbortError')
    }) as unknown as typeof fetch
    await withFetch(stub, async () => {
      await expect(new CrwSearchProvider(searchOptions).search({ query: 'q' }))
        .rejects.toMatchObject({ code: 'WEB_ABORTED' })
    })
  })
})

describe('requests', () => {
  test('search sends maxResults as limit and no answer options by default', async () => {
    let sent: unknown
    const stub = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    await withFetch(stub, async () => {
      await new CrwSearchProvider(searchOptions).search({ query: 'q', maxResults: 5 })
    })
    expect(sent).toEqual({ query: 'q', limit: 5 })
  })

  test('answer mode also requests markdown, which the API requires', async () => {
    let sent: Record<string, unknown> = {}
    const stub = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    await withFetch(stub, async () => {
      await new CrwSearchProvider({ ...searchOptions, answer: true }).search({ query: 'q' })
    })
    expect(sent.answer).toBe(true)
    expect(sent.scrapeOptions).toEqual({ formats: ['markdown'] })
  })

  test('no Authorization header when self-hosting without a key', async () => {
    let headers: Record<string, string> = {}
    const stub = (async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>
      return new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    await withFetch(stub, async () => {
      await new CrwSearchProvider({ ...searchOptions, apiKey: '', baseURL: 'http://localhost:3002' })
        .search({ query: 'q' })
    })
    expect(headers.authorization).toBeUndefined()
  })
})
