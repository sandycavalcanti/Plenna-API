import { normalizePaymentMethodName } from '../forma-pagamento/payment-method.normalizer.js';
import { parseDanfePdf } from './danfe.pdf.parser.js';
import { parseNFeXml } from './nfe.parser.js';
import { isPositivePurchaseComponent, mergeExtractedPurchase } from './email-purchase.enrichment.js';
import { GmailAttachmentError } from './gmail.attachment.js';
import { NFeXmlParseError } from './nfe.parser.js';
import { DanfePdfParseError } from './danfe.pdf.parser.js';
function hasText(value) {
    return Boolean(value?.trim());
}
function validExtractedItem(item) {
    return hasText(item.name) && (item.quantity !== null || item.unitPrice !== null || item.totalPrice !== null);
}
function nfeItems(source) {
    return source.items
        .filter((item) => hasText(item.name) && (item.quantity !== null || item.unitPrice !== null || item.totalPrice !== null))
        .map((item) => ({
        name: item.name,
        quantity: item.quantity,
        unit: item.unit,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
        categoryName: null,
    }));
}
function danfeItems(source) {
    return source.items
        .filter((item) => hasText(item.name))
        .map((item) => ({
        name: item.name,
        quantity: item.quantity,
        unit: item.unit,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
        categoryName: null,
    }));
}
function normalized(value) {
    return (value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}
function appendFiscalFreight(items, freightAmount) {
    if (freightAmount === null || freightAmount === undefined || !Number.isFinite(freightAmount) || freightAmount <= 0)
        return;
    const alreadyPresent = items.some((item) => isPositivePurchaseComponent(item)
        && normalized(item.name) === 'frete'
        && item.unitPrice !== null
        && Math.abs(item.unitPrice - freightAmount) < 0.01);
    if (alreadyPresent)
        return;
    // O frete fiscal e um componente positivo explicito; o nome permanece
    // "Frete" e a categoria textual sera resolvida pelo ID real na persistencia.
    items.push({
        name: 'Frete',
        quantity: 1,
        unit: null,
        unitPrice: freightAmount,
        totalPrice: freightAmount,
        categoryName: 'Frete/Taxas',
    });
}
function fiscalIdentity(source) {
    return [source.accessKey, source.number, source.issuer.cnpj, source.issuer.name, source.totalAmount]
        .map((value) => value ?? '')
        .join('|');
}
function selectSingleFiscalSource(sources) {
    if (sources.length === 0)
        return null;
    const identities = new Set(sources.map(fiscalIdentity));
    // Documentos fiscais diferentes nao podem ser combinados em um resultado
    // artificial; sem uma regra de negocio, a escolha segura e nao escolher.
    return identities.size === 1 ? sources[0] : null;
}
function compatibleFiscalSources(xml, danfe) {
    if (xml.accessKey && danfe.accessKey)
        return xml.accessKey === danfe.accessKey;
    // Sem chave compartilhada, numero e CNPJ precisam confirmar a mesma nota;
    // total, nome ou apenas um desses campos nao identificam documento fiscal.
    return Boolean(xml.number
        && danfe.number
        && xml.issuer.cnpj
        && danfe.issuer.cnpj
        && xml.number === danfe.number
        && xml.issuer.cnpj === danfe.issuer.cnpj);
}
function addSourceEvidence(purchase, field, source) {
    purchase.evidence = purchase.evidence.filter((item) => !(item.field === field && item.source !== source));
    purchase.evidence.push({ field, source, confidence: null, rawLabel: null, context: null });
}
function canonicalPayment(value) {
    return normalizePaymentMethodName(value);
}
function singleNfePayment(source) {
    if (!source || source.payments.length !== 1)
        return null;
    return canonicalPayment(source.payments[0].name);
}
function singleDanfePayment(source) {
    return canonicalPayment(source?.payment);
}
function invoiceFromSources(xml, danfe) {
    if (!xml && !danfe)
        return null;
    return {
        type: xml ? 'NFE_XML' : 'DANFE_PDF',
        number: xml?.number ?? danfe?.number ?? null,
        accessKey: xml?.accessKey ?? danfe?.accessKey ?? null,
        source: xml ? 'NFE_XML' : 'DANFE_PDF',
    };
}
/**
 * Faz o merge por campo, porque dados fiscais, pedido ecommerce e pagamento
 * possuem autoridades diferentes. Arrays de itens sao substituidos pela
 * fonte fiscal vencedora, nunca concatenados.
 */
export function mergePurchaseSources(deterministic, ai, fiscal, sourceText = '') {
    const merged = ai ? mergeExtractedPurchase(deterministic, ai, sourceText) : mergeExtractedPurchase(deterministic, {
        establishment: null,
        orderNumber: null,
        totalAmount: null,
        paymentMethodName: null,
        items: [],
    });
    const xml = selectSingleFiscalSource(fiscal.nfe);
    const selectedDanfe = selectSingleFiscalSource(fiscal.danfe);
    // DANFE so pode complementar XML quando ambos representam a mesma NF-e.
    // Caso contrario, o XML permanece isolado e o DANFE conflitante e ignorado.
    const danfe = xml && selectedDanfe && compatibleFiscalSources(xml, selectedDanfe) ? selectedDanfe : xml ? null : selectedDanfe;
    const establishment = xml?.issuer.name ?? danfe?.issuer.name;
    if (hasText(establishment)) {
        merged.establishment = establishment;
        addSourceEvidence(merged, 'establishment', xml?.issuer.name ? 'NFE_XML' : 'DANFE_PDF');
    }
    const total = xml?.totalAmount ?? danfe?.totalAmount;
    if (total !== null && total !== undefined) {
        merged.totalAmount = total;
        merged.totalAmountSource = 'FISCAL';
        addSourceEvidence(merged, 'totalAmount', xml?.totalAmount !== null && xml?.totalAmount !== undefined ? 'NFE_XML' : 'DANFE_PDF');
    }
    const fiscalDiscount = xml?.discountAmount ?? danfe?.discountAmount;
    if (fiscalDiscount !== null && fiscalDiscount !== undefined) {
        merged.discountAmount = fiscalDiscount;
    }
    const xmlItems = xml ? nfeItems(xml) : [];
    const danfeItemValues = danfe ? danfeItems(danfe) : [];
    const fiscalItems = xmlItems.length > 0 ? xmlItems : danfeItemValues;
    if (fiscalItems.length > 0) {
        merged.items = fiscalItems;
        addSourceEvidence(merged, 'items', xmlItems.length > 0 ? 'NFE_XML' : 'DANFE_PDF');
    }
    else if (!merged.items.some(validExtractedItem)) {
        merged.items = [];
    }
    appendFiscalFreight(merged.items, xml?.freightAmount ?? danfe?.freightAmount);
    const fiscalPayment = singleNfePayment(xml) ?? singleDanfePayment(danfe);
    if (fiscalPayment) {
        merged.paymentMethod = { rawName: fiscalPayment };
        addSourceEvidence(merged, 'paymentMethod', xml && singleNfePayment(xml) ? 'NFE_XML' : 'DANFE_PDF');
    }
    else if (merged.paymentMethod.rawName) {
        merged.paymentMethod = { rawName: canonicalPayment(merged.paymentMethod.rawName) ?? merged.paymentMethod.rawName };
    }
    const invoice = invoiceFromSources(xml, danfe);
    if (invoice) {
        merged.invoice = invoice;
        addSourceEvidence(merged, 'invoice', xml ? 'NFE_XML' : 'DANFE_PDF');
    }
    // Pedido ecommerce nunca e substituido por nNF ou pela chave fiscal.
    return merged;
}
/** Baixa e interpreta apenas anexos fiscais, isolando falhas de documentos. */
export async function parseFiscalAttachments(attachments, download) {
    const nfe = [];
    const danfe = [];
    for (const metadata of attachments) {
        const mimeType = metadata.mimeType?.toLowerCase();
        if (mimeType !== 'application/xml' && mimeType !== 'text/xml' && mimeType !== 'application/pdf')
            continue;
        try {
            const downloaded = await download(metadata);
            if (mimeType === 'application/pdf') {
                const result = await parseDanfePdf(downloaded.bytes);
                if (result.status === 'PARSED')
                    danfe.push(result.danfe);
            }
            else {
                nfe.push(parseNFeXml(downloaded.bytes));
            }
        }
        catch (error) {
            // XML/PDF invalido nao deve apagar uma compra que ainda possui evidencia
            // textual; o parser fiscal permanece um enriquecimento opcional.
            if (error instanceof GmailAttachmentError
                || error instanceof NFeXmlParseError
                || error instanceof DanfePdfParseError)
                continue;
            throw error;
        }
    }
    return { nfe, danfe };
}
