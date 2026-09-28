const MONEY_VALUE = '(?:(?:\\d{1,3}(?:\\.\\d{3})+|\\d+),\\d{2}|\\d+\\.\\d{2})';
const PRODUCT_LABELS = ['produto', 'item', 'descricao'];
const POSITIVE_COMPONENT_LABELS = [
    { label: 'taxa de servico', name: 'Taxa de serviço' },
    { label: 'taxa de conveniencia', name: 'Taxa de conveniência' },
    { label: 'taxa adicional', name: 'Taxa adicional' },
    { label: 'taxa administrativa', name: 'Taxa administrativa' },
    { label: 'taxa de entrega', name: 'Taxa de entrega' },
    { label: 'valor do frete', name: 'Frete' },
    { label: 'frete', name: 'Frete' },
    { label: 'entrega', name: 'Frete' },
    { label: 'taxa', name: 'Taxa' },
];
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
        if (isPurchaseBlockBoundary(lines[index]))
            break;
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
            return { quantity, label: candidate.label, context: candidate.context, index };
    }
    return null;
}
function isPurchaseBlockBoundary(line) {
    const normalizedLine = normalize(line);
    return /^(?:subtotal(?: dos produtos)?|total(?: da compra| do pedido| pago| final)?|valor total|valor final|frete|entrega|taxa(?: de [^:]+)?|desconto|cupom|cashback|parcela|juros|forma de pagamento|pagamento|voce tambem pode gostar|recomendados?|produtos recomendados|compre tambem|talvez voce goste)\b/i.test(normalizedLine);
}
function isItemAttribute(line) {
    const normalizedLine = normalize(line);
    return /^(?:tamanho|cor|modelo|variante|voltagem|marca|sku)\s*:/i.test(normalizedLine);
}
function findNameBeforeQuantity(lines, quantityIndex) {
    for (let index = quantityIndex - 1; index >= Math.max(0, quantityIndex - 6); index -= 1) {
        const line = lines[index].trim();
        if (!line || isPurchaseBlockBoundary(line))
            break;
        if (/^(?:quantidade|qtd)\b/i.test(normalize(line)))
            break;
        if (isItemAttribute(line) || isItemLabel(line) || /^r\$?\s*[\d.,]+$/i.test(line))
            continue;
        return { name: line, index };
    }
    return null;
}
/**
 * Em tabelas HTML linearizadas, o preco pode ficar em uma linha isolada logo
 * apos a quantidade. A proximidade e os bloqueios semanticos evitam capturar
 * frete, desconto, total ou recomendacoes como preco do produto.
 */
function findAdjacentItemMoney(lines, start, limit = 3) {
    for (let index = start; index < Math.min(lines.length, start + limit); index += 1) {
        const normalizedLine = normalize(lines[index]);
        if (/\b(frete|taxa|desconto|total|cupom|cashback|parcela|juros|recomend|voce tambem pode gostar)\b/i.test(normalizedLine))
            return null;
        const match = lines[index].trim().match(new RegExp(`^(?:r\\$\\s*)?(${MONEY_VALUE})$`, 'i'));
        const amount = match?.[1] ? parseMoney(match[1]) : null;
        if (amount !== null)
            return amount;
        if (isItemLabel(lines[index]))
            return null;
    }
    return null;
}
function extractItems(text, evidence) {
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const items = [];
    const handledNames = new Set();
    // Primeiro preservamos o formato legado com o rótulo "Produto".
    for (let index = 0; index < lines.length; index += 1) {
        const labeledProduct = lineValue(lines, index, PRODUCT_LABELS);
        const product = labeledProduct;
        if (!product)
            continue;
        const name = product.value.trim();
        if (!name || /^R\$?\s*[\d.,]+$/i.test(name) || isItemLabel(name))
            continue;
        const quantity = findQuantity(lines, index + 1);
        const unitPrice = findLabeledMoney(lines, index + 1, ['valor unitario', 'preco unitario', 'valor do produto', 'preco do produto']);
        const totalPrice = findLabeledMoney(lines, index + 1, ['subtotal', 'total do item', 'valor total do item', 'valor dos produtos']);
        const adjacentPrice = !unitPrice && !totalPrice && quantity
            ? findAdjacentItemMoney(lines, quantity.index + 1)
            : null;
        const normalizedName = normalize(product.value.trim());
        if (handledNames.has(normalizedName))
            continue;
        handledNames.add(normalizedName);
        items.push({
            name,
            quantity: quantity?.quantity ?? null,
            // A extracao de email ainda nao possui evidencia de unidade comercial.
            // Por isso nao inventamos UN para produtos que mostram apenas quantidade.
            unit: null,
            unitPrice: unitPrice?.amount ?? adjacentPrice,
            totalPrice: totalPrice?.amount ?? null,
            categoryName: null,
        });
        addEvidence(evidence, { field: 'items', rawLabel: product.label, context: product.context });
        if (quantity)
            addEvidence(evidence, { field: 'items', rawLabel: quantity.label, context: quantity.context });
    }
    // Tabelas HTML frequentemente removem o rótulo "Produto". Nesse formato,
    // a quantidade delimita o bloco e o valor monetário do próprio bloco pode
    // ser usado sem exigir um rótulo adicional de preço.
    for (let index = 0; index < lines.length; index += 1) {
        const quantityCandidate = lineValue(lines, index, ['quantidade', 'qtd']);
        if (!quantityCandidate)
            continue;
        const quantityMatch = quantityCandidate.value.match(/^\d+(?:[.,]\d+)?$/);
        const quantity = quantityMatch ? Number(quantityMatch[0].replace(',', '.')) : null;
        if (quantity === null || !Number.isFinite(quantity) || quantity <= 0)
            continue;
        const quantityIndex = /^\s*(?:quantidade|qtd)\s*:/i.test(lines[index]) ? index : index + 1;
        const nameCandidate = findNameBeforeQuantity(lines, index);
        if (!nameCandidate)
            continue;
        const normalizedName = normalize(nameCandidate.name);
        if (handledNames.has(normalizedName))
            continue;
        const price = findAdjacentItemMoney(lines, quantityIndex + 1, 6);
        const labeledUnitPrice = findLabeledMoney(lines, quantityIndex + 1, ['valor unitario', 'preco unitario', 'valor do produto', 'preco do produto']);
        const labeledTotalPrice = findLabeledMoney(lines, quantityIndex + 1, ['subtotal', 'total do item', 'valor total do item', 'valor dos produtos']);
        const resolvedUnitPrice = labeledUnitPrice?.amount ?? (quantity === 1 ? price : null);
        const resolvedTotalPrice = labeledTotalPrice?.amount ?? (quantity > 1 ? price : quantity === 1 ? price : null);
        items.push({
            name: nameCandidate.name,
            quantity,
            unit: null,
            unitPrice: resolvedUnitPrice,
            totalPrice: resolvedTotalPrice,
            categoryName: null,
        });
        handledNames.add(normalizedName);
        addEvidence(evidence, { field: 'items', rawLabel: 'item', context: nameCandidate.name });
        addEvidence(evidence, { field: 'items', rawLabel: 'quantidade', context: quantityCandidate.context });
    }
    return items;
}
function extractPositiveComponents(text, evidence) {
    const components = [];
    const lines = text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const normalizedLine = normalize(line);
        const component = POSITIVE_COMPONENT_LABELS.find(({ label }) => new RegExp(`^${label}(?:\\s*:|$)`).test(normalizedLine));
        if (!component)
            continue;
        const inlineMatch = normalizedLine.match(/:\s*(?:r\$\s*)?(\d[\d.]*[,.]\d{2})\s*$/i);
        const nextLineMatch = lines[index + 1]?.match(/^\s*(?:r\$\s*)?(\d[\d.]*[,.]\d{2})\s*$/i);
        const match = inlineMatch ?? nextLineMatch;
        const amount = match?.[1] ? parseMoney(match[1]) : null;
        if (amount === null)
            continue;
        components.push({
            name: component.name,
            quantity: 1,
            unit: null,
            unitPrice: amount,
            totalPrice: amount,
            categoryName: 'Frete/Taxas',
        });
        addEvidence(evidence, { field: 'items', rawLabel: component.name, context: line });
    }
    return components;
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
        const total = findSemanticMoney(text, ['valor total pago', 'total da compra', 'total do pedido', 'total final', 'valor final', 'total pago', 'voce pagou', 'valor pago', 'valor total', 'total']);
        const order = extractOrderNumber(text);
        const payment = extractPaymentMethod(text);
        const establishment = extractEstablishment(email, text, evidence);
        const items = [
            ...extractItems(email.textBody ?? '', evidence),
            ...extractPositiveComponents(email.textBody ?? '', evidence),
        ];
        const discount = findSemanticMoney(text, ['valor do desconto', 'desconto']);
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
            totalAmountSource: total ? 'DETERMINISTIC_SEMANTIC' : null,
            discountAmount: discount?.amount ?? null,
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
