# Merge de codex-delegate — 2026-10-20

## Fontes e escopo

- Upstream: `amElnagdy/delegate-skills`, subpasta `skills/codex-delegate`.
- BASE: `8f1a95832d94256b2645ea038ce4a356a7b19acb` (`8f1a958`).
- NOSSA: `C:/Users/brrod/.agents/skills/codex-delegate/`, estado anterior a este merge.
- OFICIAL: `3aa72d681a79e2a9d09bd9a316353003ae1cb4a7` (`3aa72d6`).
- Clone local consultado: `C:/Users/brrod/AppData/Local/Temp/claude/D--ai-dubbing-pipeline-teste/3169b478-5afa-4b53-bdee-ca5ea9e84f52/scratchpad/upstream-ds`.
- ANTIGA, consultada somente para comparação: `D:/claude-repo/.claude/skills/codex-delegate/`.
- Backup existente, não acessado nem alterado: `C:/Users/brrod/AppData/Local/Temp/claude/D--ai-dubbing-pipeline-teste/3169b478-5afa-4b53-bdee-ca5ea9e84f52/scratchpad/codex-delegate.bak-202610202122/`.

Somente a pasta NOSSA recebeu alterações. Sem rede, commit ou execução do Codex real.
O roteador local informou `enabled=false`, `reason=not_git_repository`.

## Resultado da comparação em três sentidos

Os seis arquivos originais de NOSSA são iguais à BASE após normalizar CRLF para LF.
A diferença de bytes é exclusivamente de fim de linha; os CRLF locais foram mantidos
nos três arquivos atualizados. Hashes SHA-256 anteriores e comparação por arquivo estão
em [.merge-upstream/before-hashes.json](.merge-upstream/before-hashes.json).
Portanto, não apareceu customização de conteúdo exclusiva de NOSSA em BASE→NOSSA.

ANTIGA tem cinco arquivos iguais à BASE e apenas `scripts/relay.mjs` diferente:
usa `execFileSync` com `shell:true` na consulta de versão e `spawn` com array de
argumentos e `shell:true` no Windows. NOSSA e BASE já têm a correção para Node 24:
`execSync("codex --version", ...)` no Windows e `spawnShellLaunch`, serializando os
argumentos uma vez. Esse comportamento foi preservado, sem restaurar a implementação
mais antiga. Comparação registrada em [.merge-upstream/old-relay.diff](.merge-upstream/old-relay.diff).

## Decisões por arquivo

| Arquivo | Decisão |
| --- | --- |
| `scripts/relay.mjs` | Incorporado o delta oficial completo: `--subagent-model`, `--subagent-effort`, `--web-search`, `--network-access`, validação e configurações após `resume`. Igual ao OFICIAL em conteúdo; mantém o lançamento Windows já presente na BASE/NOSSA. |
| `SKILL.md` | Acrescentados os exemplos das quatro flags. Excluídos os três blocos novos que tornam `codex-background` obrigatório para orquestração pelo Codex: o irmão não está instalado e essa exigência interromperia o fluxo shell atual. Demais instruções e frontmatter preservados. |
| `references/dispatch-and-poll.md` | Incorporado o delta oficial completo: flags, limites, rede, retomadas, campos aditivos e diagnóstico. Igual ao OFICIAL em conteúdo. |
| `references/writing-the-brief.md` | Intacto; BASE, NOSSA, ANTIGA e OFICIAL têm o mesmo conteúdo. |
| `references/review-and-land.md` | Intacto; BASE, NOSSA, ANTIGA e OFICIAL têm o mesmo conteúdo. |
| `references/multi-task-queues.md` | Intacto; BASE, NOSSA, ANTIGA e OFICIAL têm o mesmo conteúdo. |
| `scripts/merge-upstream.test.mjs` | Criado teste offline do relay, com APIs de processos substituídas antes da avaliação; não chama executáveis. |
| `MERGE-UPSTREAM.md` | Este registro de fontes, decisões, verificação e repetição. |
| `.merge-upstream/` | Evidências locais: hashes, diffs, logs, cópia da BASE para validar o frontmatter e artefatos sintéticos dos testes. |

## Contrato de economia-quota

Preservadas todas as flags existentes, seus defaults e o schema
`delegate-relay.result.v1`. Os campos existentes mantêm nomes, tipos e semântica,
incluindo `status`, `exitCode`, `signal`, `threadId`, `finalMessage`, `touchedFiles`,
`stderrTail`, `error` e caminhos de artefatos. Permanecem os estados `completed`,
`failed`, `timeout`, `aborted`, `codex_unavailable`; erros de uso continuam saindo
com código 2 antes de criar resultado. A publicação de JSON continua atômica.

O delta oficial acrescenta somente quatro metadados: `subagentModel`, `subagentEffort`,
`webSearch` (default `null`) e `networkAccess` (default `false`). Nenhum campo antigo
foi removido ou renomeado. Não foram alterados `delegar.mjs` nem seus selftests.

Preservados também: `--ignore-user-config`, ambiente limpo e opt-ins, remoção de
WindowsApps somente para sandbox Windows, PATH intacto em `danger-full-access`,
retomada por sessão e por última sessão, sandbox explícito antes de `resume`,
watchdog, limite do preflight, diagnósticos limitados a 64 KiB e UTF-8 entre chunks.

## Verificação

Não existia teste/selftest do relay em `scripts/`; havia apenas `relay.mjs`.
O teste novo foi executado contra o relay original antes da atualização e depois.

| Verificação | Baseline | Após merge |
| --- | --- | --- |
| `node --test scripts/merge-upstream.test.mjs` | 11 passaram, 2 novos cenários ignorados (flags ainda ausentes), exit 0 | 13 passaram, 0 ignorados, exit 0 |
| `node C:/Users/brrod/.claude/skills/economia-quota/scripts/delegar.selftest.mjs` | 38 passaram, exit 0 | 38 passaram, exit 0 |
| `node C:/Users/brrod/.claude/skills/economia-quota/scripts/delegar-pi.selftest.mjs` | 9 passaram, exit 0 | 9 passaram, exit 0 |
| `quick_validate.py` da skill-creator | Rejeita `compatibility`, exit 1 | Mesma rejeição, exit 1 |

O validador aceita apenas `allowed-tools`, `description`, `license`, `metadata` e
`name`. O campo `compatibility` já existia na BASE; foi conservado para respeitar
o pedido de preservar a skill. Logs: `.merge-upstream/baseline-*.log`,
`.merge-upstream/final-*.log`, `.merge-upstream/validate-baseline.log` e
`.merge-upstream/validate.log`.

O teste do relay cobre argumentos e quoting Windows, preflight, isolamento de
configuração/ambiente, retomadas, JSON v1, stdin, Unicode, diagnósticos, sucesso,
falha, indisponibilidade, sinais, watchdog e aborto, além das flags novas e rejeições
de rede com read-only/retomada sem sandbox explícito. Processos e timers são simulados.

## Como repetir offline

1. Use a pasta NOSSA como diretório de trabalho. Antes de desenvolvimento, consulte
   o roteador com `python C:/Users/brrod/.codex/skills/delegate-to-remote-ec2/scripts/remote_mode.py status --repo C:/Users/brrod/.agents/skills/codex-delegate`.
2. Faça inventário dos arquivos e rode os testes existentes e os dois selftests externos.
   Para aplicar este teste à versão anterior sem as flags novas, defina apenas para
   essa execução `CODEX_DELEGATE_MERGE_BASELINE=1`; remova a variável após o baseline.
3. Defina `$clone` no PowerShell com o caminho completo do clone acima. Consulte cada
   arquivo da BASE com `git -C $clone show 8f1a958:skills/codex-delegate/<arquivo>`
   e o delta com `git -C $clone diff 8f1a958 3aa72d6 -- skills/codex-delegate`.
   Compare também BASE→NOSSA, normalizando apenas fins de linha, e leia ANTIGA sem editá-la.
4. Transfira apenas os hunks úteis. Havendo customização local nova em comparação com
   o estado registrado aqui, ela prevalece nos conflitos. Neste merge, aceite o relay
   e a referência oficiais, mas omita os três blocos de dependência `codex-background`
   de `SKILL.md`. Preserve os CRLF locais e os três arquivos de referência intactos.
5. Rode os três comandos de teste da tabela sem a variável de baseline. Confira os
   códigos de saída, a comparação final com o OFICIAL e o contrato do consumidor.
   Não execute `codex`, não faça commit e não modifique clone, backup ou ANTIGA.

## Limitações e riscos

- Não houve integração com Codex real; disponibilidade das flags e dos valores depende
  da versão/configuração do CLI. Os testes verificam o relay offline.
- Os campos novos são aditivos. Consumidores que rejeitem chaves JSON desconhecidas
  exigiriam análise própria; os selftests solicitados passaram.
- Rede permanece desligada por default. As flags de rede, busca e subagentes precisam
  ser reenviadas em retomadas, conforme documentado na referência oficial.
- A revisão automática bloqueou o comando de limpeza dos diretórios temporários dos
  testes; eles foram conservados em `.merge-upstream/`, sem afetar o relay.
