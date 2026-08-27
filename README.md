# Plenna API

API backend do Plenna em Node.js, TypeScript, Express e Prisma.

## Visão geral

A API concentra:

- autenticação do usuário;
- compras manuais;
- integração Gmail;
- classificação determinística;
- fallback com Gemini;
- propagandas;
- métricas de dashboard.

## Arquitetura do módulo Gmail

Fluxo principal:

1. usuário conecta a conta Google via OAuth;
2. a API salva a integração Gmail em `tb_integracao`;
3. a sincronização busca apenas o intervalo necessário;
4. cada mensagem passa primeiro pela classificação determinística;
5. se a mensagem for ambígua, o Gemini é usado como fallback;
6. compras vão para `tb_compra`;
7. propagandas vão para `tb_propaganda`;
8. mensagens irrelevantes não são persistidas.

## OAuth Google

Escopos usados:

- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/userinfo.email`

Endpoints:

- `GET /email/connect`
- `GET /email/callback`

## Leitura Gmail

Rotas autenticadas:

- `GET /email/gmail/messages`
- `GET /email/gmail/messages/:messageId`

Elas retornam apenas os campos reduzidos necessários ao fluxo.

## Sincronização

O estado da integração fica em `tb_integracao`.

Campos usados:

- `integracao_ultima_sincronizacao_em`
- `integracao_sincronizacao_status`
- `integracao_ultimo_erro`

Status:

- `PENDENTE`
- `PROCESSANDO`
- `FINALIZADA`
- `ERRO`

### Semântica do timestamp

`integracao_ultima_sincronizacao_em` guarda somente a última sincronização concluída com sucesso.

Durante a execução:

- o valor de corte superior fica apenas em memória;
- a consulta usa `after` da última sync confirmada e `before` do início da execução;
- se a sincronização terminar com sucesso, o timestamp avança;
- se falhar, o timestamp não avança.

### Lock atômico

A sincronização usa `tb_integracao` como lock lógico:

- a execução tenta mudar o status para `PROCESSANDO` somente se a integração ainda não estiver nessa condição;
- se outra execução já estiver em andamento, a nova chamada retorna `JA_EM_ANDAMENTO`;
- não há tabela de lock auxiliar.

### Primeira sync

O primeiro sync usa lookback configurável por `EMAIL_SYNC_LOOKBACK_DAYS`.

### Sync incremental

As execuções seguintes usam `integracao_ultima_sincronizacao_em`.

## Classificação

A classificação é híbrida:

- primeiro passa pela engine determinística;
- se o resultado for claro, a IA não é chamada;
- se o resultado for ambíguo, o `AIProvider` é usado.

Resultados finais:

- `COMPRA`
- `PROPAGANDA`
- `IGNORAR`

### Gemini fallback

Gemini é usado apenas como fallback.

Falhas de IA em mensagens ambíguas:

- não avançam o timestamp;
- deixam a sync em `ERRO`;
- não criam duplicação, porque os registros já salvos são protegidos por unique key.

## Compras

Compras detectadas no Gmail nascem em `tb_compra` com:

- `compra_email = true`
- `compra_status = AGUARDANDO_CONFIRMACAO`
- `compra_classificacao = PENDENTE`
- `compra_email_mensagem_id = messageId`

Status:

- `AGUARDANDO_CONFIRMACAO`
- `CONFIRMADA`
- `IGNORADA`

Classificação comportamental:

- `PENDENTE`
- `IMPULSIVA`
- `NAO_IMPULSIVA`

Rotas:

- `GET /compras`
- `GET /compras/pending`
- `POST /compras`
- `POST /compras/:compraId/confirm`
- `POST /compras/:compraId/ignore`

Regra mínima de transição:

- `AGUARDANDO_CONFIRMACAO -> CONFIRMADA` permitido;
- `AGUARDANDO_CONFIRMACAO -> IGNORADA` permitido;
- `CONFIRMADA -> IGNORADA` bloqueado;
- `IGNORADA -> CONFIRMADA` bloqueado.

## Propagandas

Propagandas detectadas vão para `tb_propaganda`.

Campos persistidos:

- `usuario_id`
- `categoria_id`
- `propaganda_email_mensagem_id`
- `propaganda_remetente`
- `propaganda_assunto`
- `propaganda_estabelecimento`
- `propaganda_data_recebimento`
- `propaganda_data_criacao`

Se a categoria não for segura, `categoria_id` fica `NULL`.

`tb_categoria` é reutilizada para associação de categoria.

## Scheduler

O cron da Vercel chama:

- `GET /email/sync/cron`

Autenticação:

- cabeçalho `Authorization: Bearer <CRON_SECRET>`

`CRON_SECRET` é a variável usada pela Vercel para enviar o bearer token automaticamente.

## Vercel Cron

`vercel.json` agenda a rota a cada 3 horas.

O cron continua thin: ele apenas autentica e delega para `EmailSyncService`.

## Variáveis de ambiente

Obrigatórias ou usadas pelo código atual:

- `DATABASE_URL`
- `DIRECT_URL`
- `JWT_SECRET`
- `API_BASE_URL`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `EMAIL_SYNC_ENABLED`
- `EMAIL_SYNC_LOOKBACK_DAYS`
- `EMAIL_SYNC_BATCH_SIZE`
- `EMAIL_SYNC_MAX_USERS_PER_RUN`
- `CRON_SECRET`
- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `GEMINI_TIMEOUT_MS`

## Setup local

1. instalar dependências;
2. configurar `.env`;
3. rodar Prisma;
4. iniciar a API.

## Prisma

Comandos úteis:

- `npx prisma validate`
- `npx prisma generate`
- `npx prisma format`

## Testes

`npm run test` executa a suíte da API após build.

Cobertura principal atual:

- cron GET protegido;
- lock de sincronização;
- classificação clara e ambígua;
- validação do Gemini;
- métricas do dashboard só com compras confirmadas;
- transições básicas de status de compra.

## Segurança e privacidade

Regras aplicadas:

- não persistir corpo bruto do Gmail;
- não persistir anexos;
- não logar tokens;
- não enviar tokens para IA;
- não avançar timestamp em falha de IA para mensagem ambígua;
- manter dedupe por `messageId`.

## Limitações

- não há tabela de tracking auxiliar;
- o cron depende de Vercel Cron ou de um scheduler externo compatível;
- o fallback de categoria é conservador e pode retornar `NULL`.

## Deferred

- observabilidade de produção mais avançada;
- refinamento futuro das heurísticas de categoria;
- smoke end-to-end com Gmail real sempre que o ambiente estiver disponível.
