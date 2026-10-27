# RF018 - validacao da branch

Execucoes realizadas em 25/10/2026 nas worktrees baseadas em `origin/develop`.

| Escopo | Total | Aprovados | Falhas | Ignorados |
|---|---:|---:|---:|---:|
| RF018 especifico | 225 | 225 | 0 | 0 |
| Regressao completa da branch | 830 | 802 | 27 | 1 |
| develop isolada, mesma protecao offline | 659 | 630 | 28 | 1 |

TypeScript: aprovado. A verificacao Mobile usa a configuracao existente, sem `checkJs` global.

A suite completa retorna codigo 1: as falhas abaixo tambem foram reproduzidas em uma copia isolada da develop com as mesmas protecoes offline. Nenhum novo titulo de teste falhou apos o transporte. As quantidades totais diferem dos diretorios originais porque as alteracoes de outros requisitos nao foram transportadas.

## Falhas herdadas reproduzidas

- CRUD delete conclui quando o mês restante só possui valor desconhecido
- callback OAuth redireciona para o app no erro
- callback OAuth redireciona para o app no sucesso
- callback tem no-store e retorno correlacionado sem segredo
- compra confirmada não pode perder o valor no update
- compra manual apenas com items funciona
- compra manual com compraValor válido funciona
- compra manual é criada pelo backend como confirmada e não email
- compra pendente com valor nulo pode ser confirmada quando items definem valor válido
- confirmação recalcula métricas e retorna compra confirmada
- duas finalizações concorrentes só consomem uma vez no runner serializado
- edicao de compra confirmada recalcula métricas do mês antigo e novo
- estado distingue autorização sem conexão e não retorna tokens
- falha no consentimento desfaz integração e preserva a anterior
- finalização confirma atomicamente e preserva Outlook
- impulsividade usa contagem de valores conhecidos e não fabrica soma para grupo nulo
- listagem e detalhe selecionam somente os campos públicos anteriores
- outro usuário não consome tentativa
- preco isolado e label de promocoes nao confirmam propaganda
- reconexão substitui somente Gmail do usuário
- replay/finalização repetida não troca tokens novamente
- revogar duas vezes preserva data e remove Gmail/Outlook somente do usuário
- revogação durante Google impede confirmação posterior
- segredo incorreto não consome tentativa
- sem valores conhecidos (0 compras): retorna null e não sobrescreve métrica antiga
- state incorreto não consome tentativa
- transição de compra impede caminhos inválidos

## Prisma e integracao local

Schema validado e client gerado exclusivamente na worktree, com configuracao sem datasource real. As tabelas e migrations OAuth/recorrencias da develop foram preservadas. O SQL sintetico foi gerado sem modificar migrations.

O ensaio integrado executou **39 cenarios aprovados**, em cluster novo `127.0.0.1:55449`, com dados sinteticos. O cluster foi encerrado ao final. Inclui clientes Mobile reais, persistencia contextual, eventos, reenvios idempotentes, classificacao voluntaria, revisoes e leituras automaticas. A migration de eventos foi aplicada somente nesse banco descartavel. O baseline sintetico vem do datamodel; isso nao comprova replay de todo o historico de migrations de producao.

O teste ignorado da suite geral requer um banco explicitamente configurado; nao foi apontado ao Neon.

## Revisao por commit

O staging foi selecionado por lista explicita, verificado com `git diff --cached --check` e inspecionado para credenciais e arquivos locais. Cada commit de codigo foi validado em uma exportacao do snapshot exato do staging antes de ser criado. Arquivos novos foram formatados com Prettier temporario, sem adicionar dependencias ou reformatar modulos de outros requisitos. Nao ha lint configurado nos scripts da base.

## Pendencias

Corrigir as falhas herdadas nos requisitos correspondentes. Validar manualmente TalkBack, biometria fisica e fluxo no dispositivo com a API desta branch. A publicacao da branch nao aplica migrations, nao realiza deploy e nao homologa producao. Nao foram acessados dados reais nem executadas escritas no Neon.
