import { XMLParser, XMLValidator } from 'fast-xml-parser';
export class NFeXmlParseError extends Error {
    constructor(message) {
        super(message);
        this.name = 'NFeXmlParseError';
    }
}
const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    trimValues: true,
    parseTagValue: false,
    processEntities: false,
    ignoreDeclaration: true,
    maxNestedTags: 100,
});
function asRecord(value) {
    return typeof value === 'object' && value !== null ? value : null;
}
function asText(value) {
    if (typeof value === 'string' && value.trim())
        return value.trim();
    if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    return null;
}
function asArray(value) {
    if (Array.isArray(value))
        return value.map(asRecord).filter((item) => item !== null);
    const record = asRecord(value);
    return record ? [record] : [];
}
function parseNonNegative(value) {
    const text = asText(value)?.replace(',', '.');
    if (!text)
        return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function parsePositive(value) {
    const parsed = parseNonNegative(value);
    return parsed !== null && parsed > 0 ? parsed : null;
}
function parseUnit(value) {
    // uCom e a unidade comercial da NF-e; ela nao e inferida a partir de qCom.
    // O limite acompanha a coluna preparada para persistencia futura.
    const unit = asText(value);
    return unit ? unit.slice(0, 10) : null;
}
function parseDate(value) {
    const text = asText(value);
    if (!text)
        return null;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
}
function parseAccessKey(value) {
    const id = asText(value);
    const match = id?.match(/^NFe(\d{44})$/);
    return match?.[1] ?? null;
}
function paymentName(code, description) {
    const names = {
        '01': 'Dinheiro',
        '02': 'Cheque',
        '03': 'Cartão de crédito',
        '04': 'Cartão de débito',
        '05': 'Crédito loja',
        '10': 'Vale alimentação',
        '11': 'Vale refeição',
        '12': 'Vale presente',
        '13': 'Vale combustível',
        '14': 'Duplicata mercantil',
        '15': 'Boleto bancário',
        '16': 'Depósito bancário',
        '17': 'PIX',
        '18': 'Transferência bancária, carteira digital',
        '19': 'Programa de fidelidade, cashback, crédito virtual',
        '90': 'Sem pagamento',
    };
    return (code && names[code]) ?? description ?? (code === '99' ? 'Outros' : null);
}
function rejectUnsafeXml(xml) {
    // DTD e ENTITY podem habilitar resolução externa ou expansão de entidades;
    // rejeitar antes do parser cria uma barreira independente da biblioteca.
    if (/<\s*!DOCTYPE\b/i.test(xml) || /<\s*!ENTITY\b/i.test(xml)) {
        throw new NFeXmlParseError('XML com DTD ou entidade customizada nao suportado');
    }
}
function parseXml(xml) {
    rejectUnsafeXml(xml);
    const validation = XMLValidator.validate(xml);
    if (validation !== true)
        throw new NFeXmlParseError('XML malformado');
    try {
        return asRecord(parser.parse(xml));
    }
    catch {
        throw new NFeXmlParseError('Falha ao interpretar XML');
    }
}
function findInfNFe(document) {
    const proc = asRecord(document.nfeProc);
    const nfe = asRecord(proc?.NFe ?? document.NFe);
    const infNFe = asRecord(nfe?.infNFe);
    if (!nfe || !infNFe)
        throw new NFeXmlParseError('XML nao possui estrutura de NF-e');
    return infNFe;
}
/**
 * Interpreta localmente somente a estrutura fiscal necessária ao Plenna.
 * O XML continua sendo tratado como conteúdo externo: nenhum dado é salvo,
 * enviado à IA ou usado para acessar rede durante esta etapa.
 */
export function parseNFeXml(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0)
        throw new NFeXmlParseError('Attachment XML vazio');
    const document = parseXml(bytes.toString('utf8'));
    if (!document)
        throw new NFeXmlParseError('XML vazio ou invalido');
    const infNFe = findInfNFe(document);
    const ide = asRecord(infNFe.ide);
    const emit = asRecord(infNFe.emit);
    const total = asRecord(asRecord(infNFe.total)?.ICMSTot);
    const items = asArray(infNFe.det).map((det) => {
        const product = asRecord(det.prod);
        return {
            name: asText(product?.xProd),
            quantity: parsePositive(product?.qCom),
            unit: parseUnit(product?.uCom),
            unitPrice: parsePositive(product?.vUnCom),
            totalPrice: parseNonNegative(product?.vProd),
        };
    });
    const payments = asArray(asRecord(infNFe.pag)?.detPag).map((payment) => {
        const code = asText(payment.tPag);
        return {
            code,
            name: paymentName(code, asText(payment.xPag)),
            amount: parseNonNegative(payment.vPag),
        };
    });
    return {
        number: asText(ide?.nNF),
        accessKey: parseAccessKey(infNFe['@_Id']),
        issuedAt: parseDate(ide?.dhEmi ?? ide?.dEmi),
        issuer: { name: asText(emit?.xNome), cnpj: asText(emit?.CNPJ) },
        totalAmount: parseNonNegative(total?.vNF),
        freightAmount: parseNonNegative(total?.vFrete),
        discountAmount: parseNonNegative(total?.vDesc),
        items,
        payments,
    };
}
