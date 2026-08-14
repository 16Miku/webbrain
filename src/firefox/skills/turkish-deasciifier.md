# Turkish deasciifier

```webbrain-skill
{
  "summary": "Restore Turkish characters in ASCII Turkish text only when the user explicitly asks to deasciify or fix its Turkish characters.",
  "modes": ["ask", "act"],
  "intents": ["turkish_deasciify", "restore_turkish_diacritics", "fix_turkish_characters", "ascii_turkish_conversion"]
}
```

Convert ASCII Turkish text to natural Turkish spelling only when the user explicitly requests this transformation. Never infer permission from the user's language, locale, page language, or destination field.

## Preserve the source

- Change only contextually appropriate ASCII Turkish letters into `ç Ç ğ Ğ ı İ ö Ö ş Ş ü Ü`.
- Preserve all other characters, whitespace, punctuation, line breaks, capitalization, and formatting.
- Do not rewrite, translate, summarize, humanize, or otherwise edit the text.
- Leave URLs, email addresses, usernames, identifiers, code, credentials, and already-correct Unicode text unchanged unless the user explicitly includes them in the requested conversion.
- If the source is not Turkish or the intended Turkish spelling is materially ambiguous, do not guess. Ask for clarification or leave the ambiguous token unchanged.

## Ask mode

Return the converted text without commentary unless the user asks for an explanation.

Example:

- Input: `Bugun Turkce karakterleri duzeltip gorusuruz yaz.`
- Output: `Bugün Türkçe karakterleri düzeltip görüşürüz yaz.`

## Act mode

1. Convert the requested text before interacting with the page.
2. Recheck that no non-target content changed.
3. Enter the converted result with the ordinary `set_field` or `type_ax` tool.
4. Verify the rendered value exactly before saving or submitting.

Form-entry tools always type their `text` argument verbatim. Do not look for or invent a language-transform parameter. If the user supplied exact text without requesting conversion, type it unchanged and do not apply this skill.
