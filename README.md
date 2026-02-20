# @ntindle/agent-browser-plugin

OpenClaw plugin that wraps [agent-browser](https://github.com/vercel-labs/agent-browser) as native tools with automatic Cloudflare R2 upload for screenshots and video recordings.

## Features

- **14 native tools** with intelligent grouping to minimize context usage
- **Automatic R2 upload** for screenshots and recordings
- **GIF conversion** via ffmpeg for GitHub embedding
- **Device emulation** for mobile testing
- **Session management** with idle cleanup
- **Escape hatch** (`browser_advanced`) for 50+ raw actions

## Installation

```bash
openclaw plugins install @ntindle/agent-browser-plugin
```

## Tools

### Core Tools

| Tool | Description |
|------|-------------|
| `browser_open` | Navigate to URL (creates session) |
| `browser_navigate` | History: back, forward, reload |
| `browser_snapshot` | Get accessibility tree with refs (@e1, @e2...) |
| `browser_click` | Click element by ref or selector |
| `browser_fill` | Fill input field |
| `browser_close` | Close browser session |

### Interaction & Query

| Tool | Description |
|------|-------------|
| `browser_interact` | hover, focus, drag, scroll, type, press, select, check/uncheck, dblclick |
| `browser_query` | gettext, isvisible, isenabled, ischecked, title, url, count |

### Media

| Tool | Description |
|------|-------------|
| `browser_screenshot` | Screenshot with optional device emulation, R2 upload |
| `browser_record_start` | Start video recording |
| `browser_record_stop` | Stop recording, convert to GIF (optional), upload to R2 |

### Settings & Tabs

| Tool | Description |
|------|-------------|
| `browser_tabs` | Tab management: list, new, switch, close |
| `browser_settings` | viewport size, device emulation |

### Escape Hatch

| Tool | Description |
|------|-------------|
| `browser_advanced` | Run any of 50+ actions. Call with no `action` param to see the list. |

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

## Usage Examples

```
# Basic browsing
browser_open(session: "qa", url: "https://example.com")
browser_snapshot(session: "qa")
browser_click(session: "qa", selector: "@e2")
browser_fill(session: "qa", selector: "@e3", value: "test@example.com")

# Mobile testing
browser_screenshot(session: "qa", label: "mobile-view", device: "iPhone 14")

# Advanced interactions
browser_interact(session: "qa", action: "scroll", value: "down", amount: 500)
browser_interact(session: "qa", action: "hover", selector: "@e5")
browser_interact(session: "qa", action: "press", value: "Enter")

# Query page state
browser_query(session: "qa", action: "gettext", selector: "@e1")
browser_query(session: "qa", action: "isvisible", selector: "#modal")
browser_query(session: "qa", action: "title")

# Tabs
browser_tabs(session: "qa", action: "new", url: "https://google.com")
browser_tabs(session: "qa", action: "list")
browser_tabs(session: "qa", action: "switch", index: 0)

# Recording
browser_record_start(session: "qa", label: "walkthrough")
# ... do stuff ...
browser_record_stop(session: "qa")
  → { localPath: "/tmp/...", remoteUrl: "https://cdn.../...", markdown: "![recording](...)" }

# Escape hatch for advanced actions
browser_advanced(session: "qa")  # Lists all 50+ available actions
browser_advanced(session: "qa", action: "wait", params: { selector: "#loading" })
browser_advanced(session: "qa", action: "cookies_get", params: {})
browser_advanced(session: "qa", action: "evaluate", params: { expression: "document.title" })

# Cleanup
browser_close(session: "qa")
```

## Why This Plugin?

Built for QA agents that need to:
- Embed visual evidence in GitHub PR reviews (GIFs embed inline, videos don't)
- Test mobile viewports without manual setup
- Reduce tool call overhead vs CLI (native tools are faster)
- Have an escape hatch for advanced automation

## Development

```bash
bun install
bun test
```

## License

MIT
