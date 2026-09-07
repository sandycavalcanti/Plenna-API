const MONEY_VALUE = '(?:(?:\\d{1,3}(?:\\.\\d{3})+|\\d+),\\d{2}|\\d+\\.\\d{2})';
const PRODUCT_LABELS = ['produto', 'item', 'descricao'];
const ITEM_LABELS = [
    ...PRODUCT_LABELS,
    'quantidade',
    'qtd',
    'valor do produto',
    'valor unitario',
    'preco unitario',
    'preco do produto',
    'subtotal',
    'total do item',
    'valor total do item',
    'frete',
    'voce pagou',
    'forma',
    'pagamento',
    'pix',
    'cartao de credito',
    'cartao de debito',
    'boleto',
    'paypal',
];
function normalize(value) {
    return (value ?? '')
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase();
}
function sourceText(email) {
    return [email.textBody, email.subject, email.snippet].filter((value) => Boolean(value?.trim())).join('\n');
}
function parseMoney(value) {
    const normalized = value.replace(/R\$\s*/gi, '').trim();
    const parsed = normalized.includes(',') ? Number(normalized.replace(/\./g, '').replace(',', '.')) : Number(normalized.replace(/,/g, ''));
    return Number.isFinite(parsed) && parsed > 0 ? Number(parsed.toFixed(2)) : null;
}
function addEvidence(evidence, input) {
    evidence.push({
        field: input.field,
        source: 'EMAIL_TEXT',
        confidence: null,
        rawLabel: input.rawLabel,
        context: input.context.replace(/\s+/g, ' ').trim(),
    });
}
function findSemanticMoney(text, labels) {
    const normalizedText = normalize(text);
    for (const label of labels) {
        const pattern = new RegExp(`\\b${label}\\b\\s*:?\\s*(?:\\n\\s*)?(?:r\\$\\s*)?(${MONEY_VALUE})`, 'i');
        const match = normalizedText.match(pattern);
        if (match?.[1]) {
            const amount = parseMoney(match[1]);
            if (amount !== null) {
                return { amount, label, context: match[0] };
            }
        }
    }
    return null;
}
function extractOrderNumber(text) {
    const patterns = [
        /\bn(?:úmero|umero)\s+do\s+pedido\b\s*:?\s*#?\s*([a-z0-9][a-z0-9/_-]{1,39})/i,
        /\bpedido\b\s*(?:#|n(?:úmero|umero|[ºo])\s*:?)\s*([a-z0-9][a-z0-9/_-]{1,39})/i,
        /\bpedido\b\s+([a-z0-9][a-z0-9/_-]{2,39})/i,
        /\border\b\s*#?\s*([a-z0-9][a-z0-9/_-]{1,39})/i,
    ];
    const ignoredStatusWords = new Set(['foi', 'foi-entregue', 'entregue', 'enviado', 'confirmado', 'chegou', 'aprovado']);
    for (const [patternIndex, pattern] of patterns.entries()) {
        const match = text.match(pattern);
        const value = match?.[1]?.trim();
        const genericPatternHasDigit = patternIndex !== 2 || /\d/.test(value ?? '');
        if (match && value && genericPatternHasDigit && !ignoredStatusWords.has(normalize(value))) {
            return { value, context: match[0] };
        }
    }
    return null;
}
function extractPaymentMethod(text) {
    const normalizedText = normalize(text);
    const methods = [
        { pattern: /\bpix\b/i, name: 'Pix' },
        { pattern: /\bcart[aã]o\s+de\s+cr[eé]dito\b/i, name: 'Cartão de crédito' },
        { pattern: /\bcart[aã]o\s+de\s+d[eé]bito\b/i, name: 'Cartão de débito' },
        { pattern: /\bboleto\b/i, name: 'Boleto' },
        { pattern: /\bpaypal\b/i, name: 'PayPal' },
    ];
    for (const method of methods) {
        const match = normalizedText.match(method.pattern);
        if (match)
            return { name: method.name, context: match[0] };
    }
    return null;
}
function cleanSenderName(from) {
    if (!from)
        return null;
    const displayName = from.match(/^\s*["']?([^"'<]+?)["']?\s*</)?.[1]?.trim();
    if (!displayName || displayName.includes('@'))
        return null;
    return displayName;
}
function isItemLabel(line) {
    const normalizedLine = normalize(line)
        .replace(/\s*:\s*$/, '')
        .trim();
    return ITEM_LABELS.some((label) => normalizedLine === label || normalizedLine.startsWith(`${label}:`));
}
function isProductStart(line) {
    const normalizedLine = normalize(line).replace(/\s*:\s*$/, '').trim();
    return PRODUCT_LABELS.some((label) => normalizedLine === label || normalizedLine.startsWith(`${label}:`));
}
function lineValue(lines, index, labels) {
    const normalizedLine = normalize(lines[index]);
    const label = labels.find((candidate) => normalizedLine === candidate || normalizedLine.startsWith(`${candidate}:`));
    if (!label)
        return null;
    const sameLineValue = lines[index].replace(new RegExp(`^\\s*${label}\\s*:?\\s*`, 'i'), '').trim();
    if (sameLineValue)
        return { value: sameLineValue, label, context: lines[index] };
    const nextLine = lines[index + 1]?.trim();
    if (nextLine && !isItemLabel(nextLine))
        return { value: nextLine, label, context: `${lines[index]} ${nextLine}` };
    return null;
}
function findLabeledMoney(lines, start, labels, limit = 16) {
    for (let index = start; index < Math.min(lines.length, start + limit); index += 1) {
        if (index > start && isProductStart(lines[index]))
            break;
        const candidate = lineValue(lines, index, labels);
        if (!candidate)
            continue;
        const match = candidate.value.match(new RegExp(`(?:r\\$\\s*)?(${MONEY_VALUE})`, 'i'));
        const amount = match?.[1] ? parseMoney(match[1]) : null;
        if (amount !== null)
            return { amount, label: candidate.label, context: candidate.context };
    }
    return null;
}
function findQuantity(lines, start, limit = 16) {
    for (let index = start; index < Math.min(lines.length, start + limit); index += 1) {
        if (index > start && isProductStart(lines[index]))
            break;
        const candidate = lineValue(lines, index, ['quantidade', 'qtd']);
        if (!candidate)
            continue;
        const match = candidate.value.match(/^\d+(?:[.,]\d+)?$/);
        if (!match)
            continue;
        const quantity = Number(match[0].replace(',', '.'));
        if (Number.isFinite(quantity) && quantity > 0)
            return { quantity, label: candidate.label, context: candidate.context };
    }
    return null;
}
function extractItems(text, evidence) {
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const items = [];
    for (let index = 0; index < lines.length; index += 1) {
        const labeledProduct = lineValue(lines, index, PRODUCT_LABELS);
        const product = labeledProduct ??
            (!isItemLabel(lines[index]) && !lineValue(lines, index - 1, PRODUCT_LABELS) && lineValue(lines, index + 1, ['quantidade', 'qtd'])
                ? { value: lines[index], label: 'item', context: lines[index] }
                : null);
        if (!product)
            continue;
        const name = product.value.trim();
        if (!name || /^R\$?\s*[\d.,]+$/i.test(name) || isItemLabel(name))
            continue;
        const quantity = findQuantity(lines, index + 1);
        const unitPrice = findLabeledMoney(lines, index + 1, ['valor unitario', 'preco unitario', 'valor do produto', 'preco do produto']);
        const totalPrice = findLabeledMoney(lines, index + 1, ['subtotal', 'total do item', 'valor total do item']);
        items.push({
            name,
            quantity: quantity?.quantity ?? null,
            unitPrice: unitPrice?.amount ?? null,
            totalPrice: totalPrice?.amount ?? null,
            categoryName: null,
        });
        addEvidence(evidence, { field: 'items', rawLabel: product.label, context: product.context });
        if (quantity)
            addEvidence(evidence, { field: 'items', rawLabel: quantity.label, context: quantity.context });
    }
    return items;
}
function extractEstablishment(email, text, evidence) {
    const senderName = cleanSenderName(email.from);
    if (senderName) {
        addEvidence(evidence, { field: 'establishment', rawLabel: 'From', context: email.from ?? senderName });
        return senderName;
    }
    const match = text.match(/\b(?:vendido\s+por|estabelecimento|loja)\b\s*:\s*([^\n]{2,60})/i);
    if (match?.[1]) {
        const establishment = match[1].trim();
        addEvidence(evidence, { field: 'establishment', rawLabel: match[0].split(':')[0], context: match[0] });
        return establishment;
    }
    return null;
}
/**
 * Extrai somente dados sustentados por contexto textual claro.
 * Este componente nao classifica, nao chama IA e nao persiste o resultado.
 */
export class EmailPurchaseExtractor {
    static extract(email) {
        const text = sourceText(email);
        const evidence = [];
        const total = findSemanticMoney(text, ['valor total pago', 'total da compra', 'total do pedido', 'total pago', 'voce pagou', 'valor pago', 'valor total', 'total']);
        const order = extractOrderNumber(text);
        const payment = extractPaymentMethod(text);
        const establishment = extractEstablishment(email, text, evidence);
        const items = extractItems(email.textBody ?? '', evidence);
        if (total)
            addEvidence(evidence, { field: 'totalAmount', rawLabel: total.label, context: total.context });
        if (order)
            addEvidence(evidence, { field: 'orderNumber', rawLabel: 'pedido', context: order.context });
        if (payment)
            addEvidence(evidence, { field: 'paymentMethod', rawLabel: payment.name, context: payment.context });
        return {
            establishment,
            orderNumber: order?.value ?? null,
            totalAmount: total?.amount ?? null,
            paymentMethod: { rawName: payment?.name ?? null },
            items,
            invoice: null,
            evidence,
        };
    }
}
export function extractPurchase(email) {
    return EmailPurchaseExtractor.extract(email);
}
