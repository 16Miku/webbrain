# Skills

A skill is trusted instruction text — optionally with its own tool manifest —
that WebBrain loads into a run **only when it is relevant**. Manage them under
Settings → Skills, where you can import skill text or a URL, or remove any
bundled skill.

## How loading works

Mid and Full runs receive a small catalog of eligible skills: ID, name, summary,
and optional canonical semantic intents. Full instructions are appended to the
system prompt only after the skill is activated for the current run, via
`load_skill`. **Compact tier disables skills entirely** — no loader, no skill
prompt, no skill tools.

Imported skills are copied into browser local storage.

## Metadata

An optional fenced `webbrain-skill` JSON block can declare:

| Field | Meaning |
|---|---|
| `summary` | Maximum 200 characters |
| `modes` | `ask`, `act`, and/or `dev` |
| `intents` | Up to six canonical intents such as `verification_code` or `public_media_download` |

Intents are cross-language *meaning* hints for the LLM, not literal keyword
matching. Skills without metadata infer the first prose paragraph as their
summary, have no inferred intents, and default to Act/Dev.

## Skill tools

A skill can expose read-only HTTP tools, or short-lived download-job tools, with
a fenced `webbrain-tools` JSON manifest.

**Importing a skill is the trust boundary for its declared HTTPS endpoint.**
Download-job skill tools still run in Act mode and use the normal Downloads
permission gate before saving files. Tool results derived from third-party
content should be marked `resultPolicy: "untrusted"` so they are wrapped as
data, not instructions.

Skill tools are not part of the static [tool matrix](agent-tools.md#tool-matrix):
before a skill is loaded, or after it is removed, its tools are absent.

## Bundled skills

Both ship **enabled by default** and can be removed from Settings → Skills.

### FreeSkillz.xyz

Can expose `read_youtube_transcript`, `fetch_nytimes_article`,
`resolve_public_media`, and `download_public_media` through its skill manifest.
On NYTimes / The Athletic tabs it is preactivated for the current run so a
structured blocking `pageGate` can route directly to the credentialless article
fallback.

### OTP / verification-code helper

Loads only for relevant requests and declares no network tool. On the active run
tab it prefers selected text or a bounded accessibility-tree subtree, matches
the newest relevant service code, excludes SMS/native-app access, and honors
Strict secret handling.

When used, the scoped page content and the code are included in the normal
request to your configured LLM provider. If **Record traces** is enabled, raw
tool results and model responses are also stored locally until those traces are
deleted.

## See also

- [Agent tools](agent-tools.md) — tiers, modes, and the full tool matrix
- [Privacy and data flow](privacy-and-data-flow.md#bundled-skills)
- [Architecture](architecture.md) — skills and dynamic tool exposure in the turn
  flow
