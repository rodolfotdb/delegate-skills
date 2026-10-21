# Merge seletivo do upstream

Data: 2026-10-20. Upstream: `amElnagdy/delegate-skills`, commit **`3aa72d6`**.
Fonte somente leitura: `C:/Users/brrod/AppData/Local/Temp/claude/D--ai-dubbing-pipeline-teste/3169b478-5afa-4b53-bdee-ca5ea9e84f52/scratchpad/upstream-ds/skills/pi-delegate/`.
Destino: `C:/Users/brrod/.agents/skills/pi-delegate/`.
Sem ancestral comum: comparação semântica trecho a trecho, mantendo a implementação local como base.
O backup `scratchpad/pi-delegate.bak-202610202053/` foi apenas lido para comparação e hashes.

## Decisões por arquivo

### `scripts/relay.mjs`

Trazido/adaptado:

- Scanner incremental de objetos JSON do oficial: eventos concatenados, prefixos espúrios,
  strings/escapes, ausência de newline final e recuperação de objetos parciais acima de 1 MiB.
  Bytes completos continuam no log; o limite vale para entrada parcial retida em memória.
- Leitura de `message_end` de assistente, inclusive conteúdo string, sem substituir os eventos
  locais `turn_end`, `agent_end`, `auto_retry_end` e `agent_settled`. O último assistente continua
  sendo o relatório; mensagens intermediárias não são concatenadas ao relatório local.
- Campos adicionais `actualProvider`, `actualModel`, `stopReason`. Uso de tokens vem de
  `turn_end` quando disponível, com alternativa de `message_end`, sem contar ambos duas vezes.
- Preflight de versão assíncrono, limite de 10 s ou `--timeout` menor, falha explícita sem
  dispatch: hang produz `timeout`/124, saída não zero produz `failed` e seu código.
  Ausência de binário continua `pi_unavailable`/127. Ambos os probes têm encerramento da
  árvore de processos, tratamento de sinais capturáveis e drenagem limitada dos pipes.
- Validação de `--cd` como diretório, correção do help residual de agy, flush do decoder UTF-8
  e dicas para término externo por SIGKILL/SIGTERM.

Mantido nosso:

- Pi fixado em 1.3.0; resolução `PI_DELEGATE_BIN`/PATH/install gerenciado sem `cmd.exe`;
  brief por `@arquivo`, `-p`, diretório de sessões e preâmbulo de higiene de contexto.
- Allow-list, DeepSeek padrão com esforço `max`, Gemini alternativo, esforços explícitos e lanes.
- `createRunContext`/`reserveOutput`, proveniência de retomada, duas continuações no máximo,
  out-dir exclusivo e publicação atômica de `result.json`.
- Flags `--mcp`, `--extensions`, `--skills` opt-in; `--read-only` força MCP/extensions off,
  exclui write/edit/bash e usa fingerprint triestado, incluindo sujeira preexistente/submódulos.
- Classificação estruturada `model_unavailable`, `errorKind`, `quotaExhausted`; retries de
  `provider_unavailable` no máximo duas vezes, 10 s entre tentativas, só com árvore inalterada.
  Nenhum fallback de modelo foi inserido no relay: essa decisão continua no chamador.
- Auth probe inconclusivo não bloqueia dispatch, com limite local de 60 s. Version probe
  inconclusivo por timeout/erro agora falha explicitamente, conforme robustez do oficial.
- Contrato e nomes de artefatos locais, incluindo `pi.jsonl`, `logPath`, `sessionDir`,
  `runContext`, `dirtyBefore`, `attempts` e códigos de saída.

Descartado do oficial, com motivo:

- Modelo livre/padrão configurado no Pi e `--provider`: conflitam com allow-list/default local;
  o provider já é escolhido pelo identificador completo do modelo.
- `--resume-last`/`--continue`: não comprovam tarefa/repositório/sessão; burlariam a política local.
- `--approve`/`--no-approve` e `--tools read,grep,find,ls`: interface de outra versão do Pi,
  sem evidência de compatibilidade com o 1.3.0 local; mantidos opt-ins e exclusões existentes.
- stdin para enviar o brief ao Pi e `shell:true` no Windows: substituiria a entrega por arquivo
  e a resolução gerenciada que já tratam limites e quoting no ambiente local.
- Reutilização de out-dir apagando resultados antigos: viola reserva exclusiva e auditoria.
- Troca para `events.jsonl`/`eventsPath`, uso bruto de `usage` e status genérico `failed` para
  erro de provider: quebrariam o formato local e a decisão de fallback do wrapper.
- Declarar sucesso só por exit 0: preservada a exigência local de relatório ou mudança observável.

### `SKILL.md`

Trazido: limite explícito de ausência de sandbox, sugestão de timeout de 1–2 h para briefs maiores
e referência ao registro deste merge. Mantidos descrição, restrição a trabalho não crítico,
versão de metadata local, instalação gerenciada, modelos/esforço, fluxo, status, contexto e testes.
Descartados defaults livres, flags incompatíveis e instalação obrigatória de `codex-background`:
introduziriam outra interface ou dependência indisponível no fluxo local autorizado.

### `references/dispatch-and-poll.md`

Trazido: preflight explícito, recuperação de trabalho via log, limites de sinais no Windows,
diagnóstico de mortes externas, escalonamento POSIX/Windows e distinção entre sujeira e autoria.
Documentadas as adaptações de scanner, campos adicionais e todos os esforços já aceitos.
Mantidos flags/artefatos/status/retries locais. Descartados exemplos de CLI, nomes de log,
retomada implícita, trust flags e stdin do oficial pelas incompatibilidades acima.

### `references/writing-the-brief.md`

Trazido: descobrir gates reais, reforçar regras essenciais, relatar desvios, validar premissas
antes do dispatch e reconciliar trabalho parcial antes de corrigir o brief; critérios para
diagnóstico e pesquisa. Mantidos template compacto, higiene, limites de delegação, modelo e
entrega por arquivo. Descartados template XML duplicado, defaults livres, retomada implícita,
descrição de stdin e exemplo financeiro, incompatível com a restrição local de trabalho crítico.

### `references/review-and-land.md`

Trazido: inspecionar testes alterados/enfraquecidos, verificar comportamento stateful, procurar
APIs inexistentes/erros ocultos/scaffolding e inspecionar index/untracked antes de qualquer limpeza.
Mantidos checklist local, status de provider, `dirtyBefore`, proveniência e limite de rework.
Descartados comandos de `--resume-last` e garantias do read-only de outra versão; explicado que
`readOnlyViolation: null` não comprova ausência de alteração.

### `references/multi-task-queues.md`

Trazido: progresso atualizado por landing, notas de revisão/decisões, nomes/interfaces nos
briefs seguintes, busca final/migrações e bloqueios que invalidam tarefas dependentes.
Mantidos sessão por tarefa, quotas, seleção de modelo e revisão final. Corrigida a ambiguidade
local: apenas outra branch no mesmo checkout não isola escritores; precisam de árvores distintas.
Descartados retomada implícita e push/PR como ação automática; publicação depende de autorização.

### Arquivos exclusivos nossos

`scripts/context-policy.mjs`, `scripts/context-policy.selftest.mjs`, `scripts/fake-pi.mjs`,
`scripts/relay.test.mjs` e `scripts/relay.live.test.mjs`: preservados byte a byte, confirmado por
SHA-256 contra o backup. Não havia correspondentes oficiais. O teste live não foi executado.

### Arquivos novos deste merge

- `scripts/merge-upstream.test.mjs`: dez regressões offline de scanner, UTF-8, conteúdo string,
  quota estruturada, recuperação após retry, uso sem duplicação, preflight e diretório inválido.
  Fake próprio, sem mudar os cinco arquivos exclusivos existentes.
- `MERGE-UPSTREAM.md`: decisões, contrato, verificação e repetição.
- `validation/`: logs completos da baseline, execução final e regressões adicionais; diffs locais.

## Contrato com economia-quota

Lido `C:/Users/brrod/.claude/skills/economia-quota/scripts/delegar.mjs`, especialmente
`montarArgs`, `detectarQuotaPi`, `detectarIndisponibilidadePi` e a gravação do resultado final.
Continuam aceitos `--model`, `--effort`, `--cd`, `--brief`, `--out-dir`, `--timeout`,
`--read-only`, `--session`, `--task-id`, `--resume-from`, `--resume-reason`.
O wrapper alterna DeepSeek/Gemini no máximo uma vez e só por
`status === 'model_unavailable'` com `quotaExhausted === true` ou
`errorKind === 'provider_unavailable'`. Texto de relatório não decide fallback.
Esses campos/valores e a política de contexto continuam intactos; os novos campos são aditivos.

## Verificação

Baseline executada antes de editar código/documentação; quatro comandos com exit 0:

| Comando | Saída final baseline | Saída final após merge |
|---|---|---|
| `node scripts/relay.test.mjs` | `24/24 passed` | `24/24 passed` |
| `node scripts/context-policy.selftest.mjs` | `CONTEXT POLICY OK: 50 checks, no provider calls` | `CONTEXT POLICY OK: 50 checks, no provider calls` |
| `node C:/Users/brrod/.claude/skills/economia-quota/scripts/delegar-pi.selftest.mjs` | `PI SELFTEST OK 9` | `PI SELFTEST OK 9` |
| `node C:/Users/brrod/.claude/skills/economia-quota/scripts/delegar.selftest.mjs` | `SELFTEST OK 38` | `SELFTEST OK 38` |

Adicionais: `node scripts/merge-upstream.test.mjs` retorna
`MERGE UPSTREAM OK: 10 cases, no provider calls`; sintaxe Node e validador de skill aprovados.
Logs em `validation/baseline-*.log`, `validation/final-*.log` e `validation/merge-upstream-test.log`.
Sem rede, Pi real, commit ou push. O modo remoto estava desativado.

## Riscos e limites

- Compatibilidade com providers reais não foi exercitada, por contrato. Novas opções do Pi
  oficial não foram presumidas compatíveis com o Pi local fixado em 1.3.0.
- Windows hard kill do próprio relay é incapturável; sinais POSIX não foram exercitados aqui.
- Um objeto incompleto acima de 1 MiB pode ser descartado pelo scanner; o log bruto é preservado.
- O preflight de versão agora falha em vez de continuar depois de timeout/erro. O timeout do
  dispatch continua por tentativa; probes e intervalos de retry não formam um orçamento global.

## Como repetir

1. Obtenha separadamente uma cópia local somente leitura do próximo upstream e registre o commit.
   Não trate `3aa72d6` como ancestral do histórico local; use este registro para identificar quais
   ideias já foram incorporadas. Faça um backup novo sem sobrescrever o anterior.
2. Consulte o roteador remoto e as instruções vigentes; execute os quatro comandos acima antes
   de editar, guardando saída completa e exit codes. Leia novamente o chamador `delegar.mjs`.
3. Compare o inventário e cada arquivo com `git diff --no-index`, mantendo o destino local como
   base. Preserve contexto, modelos/esforço/fallback, segurança de saída e contrato estruturado.
   Avalie novas flags contra a versão local do Pi; não transplante interfaces sem compatibilidade.
4. Incorpore melhorias compatíveis por trecho, documentando trazido/mantido/descartado e motivo.
   Preserve arquivos exclusivos; se o relay exigir mudanças neles, registre-as explicitamente.
5. Rode os quatro comandos e `node scripts/merge-upstream.test.mjs`; compare códigos e resumos
   com a baseline, valide a skill e revise o diff contra o backup. Não execute testes live sem
   autorização. Atualize este registro e entregue resultados/riscos sem publicar automaticamente.
