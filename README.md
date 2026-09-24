# dsh-crw

[fastCRW](https://fastcrw.com)-backed `web_search` and `web_fetch` for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The harness treats web access as a capability seam (`ctx.web`) with pluggable
providers. This package registers two of them under the id `crw`, so the model
keeps the exact same `web_search` / `web_fetch` tools and only the backend
changes.

## Why

The base composition ships `web_search` on, and **`web_fetch` off**. Its own
config says why:

> Fetch stays disabled and no fetch provider is mounted: that provider defers
> SSRF protection and the model would choose the request target.

That is a fair call. The in-box HTTP fetch provider runs `fetch()` in the harness
process, and its README names the gap outright: no blocking of private, loopback,
link-local or multicast destinations, no DNS-resolve-then-validate. A model that
picks `http://169.254.169.254/` gets your cloud metadata endpoint.

fastCRW resolves and validates the target server-side and refuses private ranges,
so the harness process never opens a connection the model chose. That is what makes
turning fetch on reasonable, and it is why `fetch: true` lives in this bundle
rather than upstream.

The second reason is that plain HTTP is not how the open web reads any more:

| URL | in-box HTTP provider | dsh-crw |
| --- | --- | --- |
| `producthunt.com` | 403, a Cloudflare interstitial | 200, 27,559 chars of markdown |
| `zillow.com` | 403, "Access to this page has been denied" | 200, real page content |
| `news.ycombinator.com` | 200, raw HTML for the tool to convert | 200, markdown from the source |

fastCRW escalates per page from plain HTTP through its browser tiers only when a
page needs one, so the common case stays fast and the hard case still answers.
Not every wall falls: an interactive Cloudflare challenge still wins sometimes.

## Install

```sh
export CRW_API_KEY=...          # fastcrw.com, 500 free credits, no card
dsh plugin --profile default add dsh-crw
dsh --profile default
```

Get a key at [fastcrw.com](https://fastcrw.com). The free tier is a one-time 500
credits and needs no card; one page is one credit.

To install straight from this repo instead, pin a commit and allow the build.
A git install fetches sources, so pnpm has to run this package's `prepare`
script to produce `lib/`, and pnpm 10+ requires you to say so explicitly:

```yaml
# $DSH_HOME/profiles/<name>/pnpm-workspace.yaml
allowBuilds:
  dsh-crw: true
```

```sh
dsh plugin --profile default add github:fastcrw/dsh-crw#<sha>
```

That allowance runs this package's build on your machine at install time, so
pin the commit rather than tracking the branch.

Verify the layer before booting:

```sh
dsh --profile default --dump-config    # shows a "# == dsh-crw" layer
```

## What the bundle does

The shipped `cordis.patch.yml` applies three changes over `@deepseek-ai/dsh-base`:

- points `web.searchProvider` and `web.fetchProvider` at `crw`
- turns on `tool-web`'s `fetch` and raises both timeouts, since a page behind a
  JS or anti-bot wall escalates through browser tiers before it answers
- mounts this plugin, reading `$CRW_API_KEY`

The base layer's own DeepSeek search provider stays mounted, so switching search
back is one line in your profile's `cordis.patch.yml`:

```yaml
- id: web
  config:
    searchProvider: deepseek-official
    fetchProvider: crw
```

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `apiKey` | `$CRW_API_KEY` | fastCRW API key. Required against the cloud endpoint; empty is fine when self-hosting. |
| `baseURL` | `https://fastcrw.com/api` | Endpoint base; `/v1/search` and `/v1/scrape` are appended. |
| `search` | `true` | Register the search provider. |
| `fetch` | `true` | Register the fetch provider. |
| `answer` | `false` | Ask fastCRW to synthesize an answer over the results, returned as the seam's `content`. Adds an LLM call per search. |
| `maxBodyChars` | `100000` | Cap on returned page characters, matching the in-box provider. |

```yaml
- id: crw
  name: dsh-crw
  config:
    apiKey: !!js process.env.CRW_API_KEY
    answer: false
```

## Self-hosting

fastCRW is AGPL-3.0 and the engine is one binary, so the whole web layer can stay
on your own machine:

```sh
crw serve
```

```yaml
- id: crw
  name: dsh-crw
  config:
    baseURL: http://127.0.0.1:3002
```

A self-hosted endpoint takes no credential, so `apiKey` may be empty. The provider
only insists on a key when it is pointed at the cloud endpoint.

## Mapping notes

- **Search.** `POST /v1/search`. Each result maps to a `WebSearchSource`: `url`,
  `title`, and `snippet` from the result's snippet or, failing that, its
  description. A result without a URL is dropped rather than given an invented
  one. With `answer` on, the synthesized answer becomes the seam's `content`.
  The seam owns the final `maxResults` truncation.
- **Fetch.** `POST /v1/scrape` with `formats: ['markdown']`. The body kind is
  `text`, not `html`: fastCRW already returns markdown, and `html` would send it
  back through the tool's turndown pass to convert converted output.
- **Non-2xx targets.** fastCRW reports a 404 target as `success: false` while
  still returning what it got. The seam's contract is the other way round, so an
  envelope carrying a status code is always a result. A `WebError` is reserved
  for failing to retrieve the resource at all: a rejected URL, a bad key, an
  exhausted balance.
- **No renderer hint is sent.** fastCRW's escalation ladder decides per page
  whether plain HTTP is enough.

## Development

```sh
bun install
bun test
bun run build
```

## License

MIT.
