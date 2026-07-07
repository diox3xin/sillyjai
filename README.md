# Janitor Import — SillyTavern extension

Paste a JanitorAI character URL into SillyTavern and (one click) drop in:

* the character card (PNG + chara_card_v2 JSON), even when the bot definition is hidden;
* attached **public** lorebooks (downloaded as-is, no LLM needed);
* attached **closed** lorebooks — extracted live under your own JanitorAI session by sending a probe into a fresh chat, intercepting the assembled `generateAlpha` prompt, isolating the injected entries, and rebuilding the lorebook through the LLM you already have configured inside SillyTavern (no extra API keys).

There is also a floating **🌐 Translate keys** FAB in the bottom-right corner that takes any World Info you have and rewrites every entry's trigger keys (and secondary keys) into your roleplay language (e.g. Russian) — handy because JanitorAI lorebooks ship English keys, but you roleplay in Russian.

## Install

1. In SillyTavern open the Extensions panel (the wand icon in the top bar).
2. Click **Install Extension** → either drop the `janitor-import/` folder onto the page, or zip it first and drop the zip.
3. A right-corner FAB shows up: **🐰 Janitor Import** and **🌐 Translate keys**.

## Use (import)

1. Make sure you're logged into JanitorAI in **any** tab of the same Chrome profile (the extension opens a popup that piggybacks on your existing session).
2. Click **🐰 Janitor Import** → paste the character's URL (e.g. `https://janitorai.com/characters/abc…-…`) → tick what you want → **Extract →**.
3. A popup tab opens to the character page, the bridge is injected, metadata + public lorebooks are pulled, the card and/or closed lorebook are extracted, and the result drops into SillyTavern automatically.

If anything goes wrong (Cloudflare challenge, missing login, blocked popup), the in-modal log tells you exactly what.

## Use (translate keys)

1. Have the character whose lorebook you want open in chat, with a World Info bound to it (JanitorImport-created ones are bound automatically).
2. Click **🌐 Translate keys**.
3. Pick "Use currently-bound lorebook" (or any specific one) → pick the target language → **Translate →**.
4. When it's done, the World Info is overwritten in place. Content of entries is unchanged; only `key` and `keysecondary` arrays are rewritten.

## Notes

* **Throwaway JanitorAI account recommended.** JanitorAI scrubs scraping aggressively.
* Cloudflare Turnstile cares about headless clients — this extension uses your real Chrome, which is normally fine. If JanitorAI changes its DOM, the input selectors at the top of `index.js` (the `INPUT_SELECTORS` / `SEND_SELECTORS` arrays) are the only thing you may need to tune.
* The LLM used for both closed-lorebook rebuild and key translation is **the model already configured in SillyTavern** — same provider/key/model you roleplay with. If `API Connections` is empty in your ST, you'll see a toast telling you what to do.
* Advanced / Nine API lorebooks (whose `script` field is JavaScript rather than a JSON entries array) only leak through the trigger path — they are handled just like any other closed lorebook.

## Files

```
janitor-import/
├── manifest.json   (Extension metadata for ST's Install Extension dialog)
├── index.js        (The extension itself — one file, ~1080 lines)
└── README.md       (This file)
```

No bundler, no npm, no extra dependencies. Drop the folder into SillyTavern's Extensions panel.
