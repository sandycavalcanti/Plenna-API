import express from 'express';
import cors from 'cors';
import { usersRouter } from './modules/user/user.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { metaRouter } from './modules/meta/meta.routes.js';
import { preferenciasCategoriaRouter } from './modules/preferencia/preferencia.routes.js';
import { categoryRouter } from './modules/category/category.routes.js';
import { tempoUsoMonitoramentoRouter } from './modules/monitoramento/routes.js';
import { tempoUsoRouter } from './modules/tempo-uso/tempo-uso.routes.js';
import { emailRouter } from './modules/email/email.routes.js';
import { formaPagamentoRouter } from './modules/forma-pagamento/forma-pagamento.routes.js';
import { compraRouter } from './modules/compra/compra.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { consentimentoRouter } from './modules/consentimento/consentimento.routes.js';
import { deviceRouter, notificationRouter } from './modules/notification/notification.routes.js';
import { chatRouter } from './modules/chat/chat.routes.js';
import { analisesRouter } from './modules/analise/analise.routes.js';
import { homeRouter } from './modules/home/home.routes.js';
import { recorrenciaRouter } from './modules/recorrencia/recorrencia.routes.js';
import { RecorrenciaCronController } from './modules/recorrencia/recorrencia.cron.controller.js';
import './modules/ai/memory.runtime.js';
import { memoryRouter } from './modules/ai/memory.routes.js';
import { recomendacaoRouter } from './modules/recomendacao/recomendacao.routes.js';
import { AutomationController } from './modules/automacao/automacao.controller.js';
import { contextoRouter } from './modules/analise/contexto.routes.js';
import { eventosCompraRouter } from './modules/compra/eventos.routes.js';
const app = express();
app.use(cors());
app.use('/v2/tempo-uso', express.json({ limit: 512000 }));
app.use(express.json());
app.use('/users', usersRouter);
app.use('/auth', authRouter);
// Rota canônica do módulo de metas. O alias legado permanece temporariamente
// para versões já publicadas do aplicativo; novos clientes devem usar /metas.
app.use('/metas', metaRouter);
app.use('/preferencia', preferenciasCategoriaRouter);
app.use('/categories', categoryRouter);
app.use('/tempo-uso', tempoUsoRouter);
app.use('/v2/tempo-uso', tempoUsoMonitoramentoRouter);
app.use('/email', emailRouter);
app.use('/formas-pagamento', formaPagamentoRouter);
app.use('/compras', compraRouter);
app.use('/v2/compras', eventosCompraRouter);
app.use('/v2/compras', contextoRouter);
app.get('/recorrencias/cron', (req, res) => RecorrenciaCronController.process(req, res));
app.post('/recorrencias/cron', (req, res) => RecorrenciaCronController.process(req, res));
app.get('/ai/automation/cron', (req, res) => AutomationController.process(req, res));
app.post('/ai/automation/cron', (req, res) => AutomationController.process(req, res));
app.use('/recorrencias', recorrenciaRouter);
app.use('/dashboard', dashboardRouter);
app.use('/consentimento', consentimentoRouter);
app.use('/notifications', notificationRouter);
app.use('/devices', deviceRouter);
app.use('/historicos', chatRouter);
app.use('/analises', analisesRouter);
app.use('/home', homeRouter);
app.use('/memorias', memoryRouter);
app.use('/recomendacoes', recomendacaoRouter);
app.get('/', (_req, res) => {
    res.json({
        service: 'Plenna API',
        status: 'ok',
    });
});
app.get('/health', (_req, res) => {
    res.json({
        status: 'healthy',
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
    });
});
app.use((_req, res) => {
    res.status(404).json({
        error: 'Route not found',
    });
});
app.use((err, _req, res, _next) => {
    console.error('Unhandled application error', err);
    res.status(500).json({
        error: 'Internal server error',
    });
});
export default app;
