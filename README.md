# @ntindle/agent-browser-plugin

OpenClaw plugin that wraps [agent-browser](https://github.com/vercel-labs/agent-browser) as native tools with automatic Cloudflare R2 upload for screenshots and video recordings.

## Features

- **Native tools**: `browser_open`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_screenshot`, `browser_record_start`, `browser_record_stop`, `browser_close`
- **Automatic R2 upload**: Screenshots and recordings uploaded to Cloudflare R2
- **GIF conversion**: Optionally convert WebM recordings to GIF for GitHub embedding
- **Session management**: Multiple concurrent browser sessions with idle cleanup
- **Markdown-ready URLs**: Returns `![label](url)` strings for direct embedding

## Installation

```bash
openclaw plugins install @ntindle/agent-browser-plugin
```

## Configuration

```json5
{
  plugins: {
    entries: {
      "agent-browser": {
        enabled: true,
        config: {
          // R2 upload (optional - if not set, returns local paths only)
          r2: {
            accountId: "your-account-id",
            bucket: "your-bucket",
            publicDomain: "cdn.example.com"  // Optional
          },

          // Browser defaults
          headless: true,
          viewport: { width: 1280, height: 720 },

          // GIF conversion (optional)
          gif: {
            enabled: false  // Convert WebM → GIF before upload
          },

          // Video handling
          video: {
            speedUpAfter: 60,  // Speed up recordings longer than 60s
            maxSpeedup: 4      // Max 4x speedup
          },

          // Session management
          maxConcurrent: 3,
          idleTimeoutMs: 300000  // 5 min idle → auto-close
        }
      }
    }
  }
}
```

### Environment Variables

- `R2_ACCESS_KEY_ID` - Cloudflare R2 access key
- `R2_SECRET_ACCESS_KEY` - Cloudflare R2 secret key

## Usage

Once installed, agents can use these tools:

```
browser_open(session: "my-session", url: "https://example.com")
browser_snapshot(session: "my-session")
browser_click(session: "my-session", selector: "@e5")
browser_fill(session: "my-session", selector: "@e3", value: "hello")
browser_screenshot(session: "my-session", label: "homepage")
  → { localPath: "/tmp/...", remoteUrl: "https://cdn.../...", markdown: "![homepage](...)" }
browser_record_start(session: "my-session", label: "walkthrough")
browser_record_stop(session: "my-session")
  → { localPath: "/tmp/...", remoteUrl: "https://cdn.../...", markdown: "![recording](...)" }
browser_close(session: "my-session")
```

## Why This Plugin?

Built for QA agents that need to embed visual evidence in GitHub PR reviews:
- GitHub only embeds GIFs inline (not MP4/WebM)
- Manual upload is tedious
- `agent-browser` CLI via `exec` is slow (~66 calls per session)

This plugin provides native tools with automatic upload and format conversion.

## Development

```bash
bun install
bun test
```

## License

MIT
