# trip-assistant

Assistente da aba **Viagem** (Claude via Anthropic SDK).

- Recebe `{ mode: 'route' | 'next', text, trip }` via `sb.functions.invoke('trip-assistant', { body })`.
  - `route`: separa o texto livre do usuário em itens, escolhe a checklist de cada um
    (ou propõe uma nova), adiciona dica/urgência e indica itens que o usuário já fez.
  - `next`: analisa o que está pendente e devolve próximos passos + itens que faltam.
- Só usuários logados (`verify_jwt = true` + checagem do usuário).
- Saída em JSON estruturado (`output_config.format`), modelo `claude-opus-5-5`
  com `effort: low` e fallback automático em caso de recusa (`fallbacks: 'default'`).
- Usa o mesmo secret `ANTHROPIC_API_KEY` das outras funções.

## Deploy

```bash
supabase functions deploy trip-assistant
```

Ou pelo Dashboard: **Edge Functions → Deploy a new function → Via editor**, nome
`trip-assistant`, cole o conteúdo de `index.ts` e publique.

## Variáveis opcionais

- `TRIP_ASSISTANT_MODEL` — modelo da Anthropic. Default: `claude-opus-5-5`.
