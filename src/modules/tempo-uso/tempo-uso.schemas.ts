import { z } from 'zod';
import {
  TEMPO_USO_JANELA_DIAS,
  TEMPO_USO_MAX_ITENS_POR_LOTE,
  TEMPO_USO_SCHEMA_VERSION,
} from './tempo-uso.constants.js';

const nomeAplicativoSchema = z.string().trim().min(1).max(45);
const minutosPorDiaSchema = z.number().finite().positive().max(1440);
const dataUsoSchema = z.coerce.date().refine((data) => data.getTime() <= Date.now(), {
  message: 'A data de uso não pode estar no futuro',
});

export const tempoUsoIdSchema = z.coerce.number().int().positive();

export const createTempoUsoSchema = z.object({
  nome: nomeAplicativoSchema,
  minutos: minutosPorDiaSchema,
  data: dataUsoSchema,
}).strict();

export const updateTempoUsoSchema = z.object({
  nome: nomeAplicativoSchema.optional(),
  minutos: minutosPorDiaSchema.optional(),
  data: dataUsoSchema.optional(),
}).strict().refine((data) => Object.keys(data).length > 0, {
  message: 'Informe ao menos um campo para atualização',
});

export type CreateTempoUsoDTO = z.infer<typeof createTempoUsoSchema>;
export type UpdateTempoUsoDTO = z.infer<typeof updateTempoUsoSchema>;

const packageIdSchema = z.string()
  .min(3)
  .max(255)
  .regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/, 'packageId inválido');

const dataLocalSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dataLocal deve usar YYYY-MM-DD');
const instanteComOffsetSchema = z.string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/,
    'O instante deve ser ISO 8601 com offset explícito',
  )
  .refine((valor) => Number.isFinite(Date.parse(valor)), 'Instante inválido');

const registroSyncSchema = z.object({
  packageId: packageIdSchema,
  dataLocal: dataLocalSchema,
  timezone: z.string().trim().min(1).max(64),
  inicio: instanteComOffsetSchema,
  fim: instanteComOffsetSchema,
  duracaoSegundos: z.number().int().positive(),
}).strict();

type RegistroSyncInput = z.infer<typeof registroSyncSchema>;

function partesLocais(data: Date, timezone: string) {
  const formatador = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const partes = Object.fromEntries(formatador.formatToParts(data).map((parte) => [parte.type, parte.value]));
  return {
    dataLocal: `${partes.year}-${partes.month}-${partes.day}`,
    horario: `${partes.hour}:${partes.minute}:${partes.second}`,
  };
}

function adicionarDias(dataLocal: string, dias: number) {
  const [ano, mes, dia] = dataLocal.split('-').map(Number);
  const data = new Date(Date.UTC(ano, mes - 1, dia + dias));
  return data.toISOString().slice(0, 10);
}

function diferencaDias(inicio: string, fim: string) {
  return (Date.parse(`${fim}T00:00:00Z`) - Date.parse(`${inicio}T00:00:00Z`)) / 86_400_000;
}

export function criarSyncTempoUsoSchema(agora: Date = new Date()) {
  return z.object({
    schemaVersion: z.literal(TEMPO_USO_SCHEMA_VERSION),
    registros: z.array(registroSyncSchema).min(1).max(TEMPO_USO_MAX_ITENS_POR_LOTE),
  }).strict().superRefine((payload, contexto) => {
    const chaves = new Set<string>();

    payload.registros.forEach((registro: RegistroSyncInput, indice: number) => {
      let hojeLocal: string;
      let inicioLocal: ReturnType<typeof partesLocais>;
      let fimLocal: ReturnType<typeof partesLocais>;
      try {
        hojeLocal = partesLocais(agora, registro.timezone).dataLocal;
        inicioLocal = partesLocais(new Date(registro.inicio), registro.timezone);
        fimLocal = partesLocais(new Date(registro.fim), registro.timezone);
      } catch {
        contexto.addIssue({ code: 'custom', path: ['registros', indice, 'timezone'], message: 'timezone IANA inválido' });
        return;
      }

      const inicio = new Date(registro.inicio);
      const fim = new Date(registro.fim);
      const intervaloSegundos = (fim.getTime() - inicio.getTime()) / 1000;
      const idadeDias = diferencaDias(registro.dataLocal, hojeLocal);

      if (fim <= inicio) {
        contexto.addIssue({ code: 'custom', path: ['registros', indice, 'fim'], message: 'fim deve ser posterior a inicio' });
      }
      if (intervaloSegundos < 23 * 3600 || intervaloSegundos > 25 * 3600) {
        contexto.addIssue({ code: 'custom', path: ['registros', indice], message: 'O intervalo diário deve ter entre 23 e 25 horas' });
      }
      if (registro.duracaoSegundos > intervaloSegundos) {
        contexto.addIssue({ code: 'custom', path: ['registros', indice, 'duracaoSegundos'], message: 'A duração excede o intervalo informado' });
      }
      if (inicioLocal.dataLocal !== registro.dataLocal || inicioLocal.horario !== '00:00:00') {
        contexto.addIssue({ code: 'custom', path: ['registros', indice, 'inicio'], message: 'inicio deve ser a meia-noite de dataLocal no timezone informado' });
      }
      if (fimLocal.dataLocal !== adicionarDias(registro.dataLocal, 1) || fimLocal.horario !== '00:00:00') {
        contexto.addIssue({ code: 'custom', path: ['registros', indice, 'fim'], message: 'fim deve ser a meia-noite local do dia seguinte' });
      }
      if (idadeDias < 0) {
        contexto.addIssue({ code: 'custom', path: ['registros', indice, 'dataLocal'], message: 'Intervalos futuros não são permitidos' });
      } else if (idadeDias > TEMPO_USO_JANELA_DIAS) {
        contexto.addIssue({ code: 'custom', path: ['registros', indice, 'dataLocal'], message: `Somente hoje e os ${TEMPO_USO_JANELA_DIAS} dias anteriores podem ser sincronizados` });
      }

      const chave = `${registro.packageId}\u0000${registro.inicio}\u0000${registro.fim}`;
      if (chaves.has(chave)) {
        contexto.addIssue({ code: 'custom', path: ['registros', indice], message: 'Intervalo duplicado no mesmo lote' });
      }
      chaves.add(chave);
    });
  });
}

export type SyncTempoUsoDTO = z.infer<ReturnType<typeof criarSyncTempoUsoSchema>>;
