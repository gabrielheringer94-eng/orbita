# smart-capture

Edge Function que proxia a "Captura Inteligente" do Órbita pra Anthropic API.

- Recebe `{ text: string }` (frase do usuário) via `sb.functions.invoke('smart-capture', { body: { text } })`.
- Só autenticados conseguem chamar (`verify_jwt = true`).
- Monta o system prompt do classificador server-side (data de hoje calculada no servidor).
- Retorna o JSON parseado, ou `{ error: string }` em caso de falha.

## Deploy

### Opção A — via Supabase CLI

```bash
# instalar CLI (uma vez)
brew install supabase/tap/supabase

# login + link (uma vez)
cd ~/orbita
supabase login
supabase link --project-ref dnhcfehwcnkxsfrhdevi

# secret da Anthropic
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

# deploy
supabase functions deploy smart-capture
```

### Opção B — via Dashboard

1. Abra https://supabase.com/dashboard/project/dnhcfehwcnkxsfrhdevi/functions
2. **Create a new function** → nome `smart-capture` → cole o conteúdo de `index.ts`
3. Em **Project Settings → Edge Functions → Secrets**, adicione `ANTHROPIC_API_KEY` com sua chave (`sk-ant-...`)
4. Deploy

## Variáveis opcionais

- `SMART_CAPTURE_MODEL` — modelo da Anthropic a usar. Default: `claude-sonnet-4-6`.
