export type ParsedBill = {
    type: "income" | "expense";
    category: string;
    amount: number;
    note?: string;
    tags?: string[];
    currency?: string;
    time?: Date;
};

export type TaxonomyAction = {
    kind: "category" | "tag";
    action: "create" | "rename" | "merge" | "delete";
    id?: string;
    targetId?: string;
    type?: "income" | "expense";
    name?: string;
    parentId?: string;
};

export function parseBillsFromResponse(result: string): ParsedBill[] {
    const bills: ParsedBill[] = [];
    const billRegex = /<Bill>([\s\S]*?)(?:<\/Bill>|$)/gi;
    let match: RegExpExecArray | null;

    // biome-ignore lint/suspicious/noAssignInExpressions: 逐个消费全局正则匹配结果
    while ((match = billRegex.exec(result)) !== null) {
        const billData: Partial<ParsedBill> = {};
        const lines = match[1]
            .trim()
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);

        for (const line of lines) {
            const separator = line.indexOf("=");
            if (separator < 1) continue;
            const key = line.slice(0, separator).trim();
            const value = line
                .slice(separator + 1)
                .trim()
                .replace(/^["']|["']$/g, "");

            switch (key) {
                case "type":
                    if (value === "支出" || value === "expense") {
                        billData.type = "expense";
                    } else if (value === "收入" || value === "income") {
                        billData.type = "income";
                    }
                    break;
                case "category":
                    billData.category = value;
                    break;
                case "amount": {
                    const amount = Number.parseFloat(value);
                    if (Number.isFinite(amount)) billData.amount = amount;
                    break;
                }
                case "note":
                    billData.note = value;
                    break;
                case "tag":
                    if (value) {
                        billData.tags = [...(billData.tags ?? []), value];
                    }
                    break;
                case "currency":
                    billData.currency = value;
                    break;
                case "time": {
                    const time = new Date(value);
                    if (!Number.isNaN(time.getTime())) billData.time = time;
                    break;
                }
            }
        }

        if (
            billData.type &&
            billData.category?.trim() &&
            billData.amount !== undefined
        ) {
            bills.push({
                ...(billData as ParsedBill),
                category: billData.category.trim(),
            });
        }
    }
    return bills;
}

function parseKeyValueBlocks(result: string, tagName: string) {
    const blocks: Record<string, string>[] = [];
    const regex = new RegExp(
        `<${tagName}>([\\s\\S]*?)(?:<\\/${tagName}>|$)`,
        "gi",
    );
    let match: RegExpExecArray | null;

    // biome-ignore lint/suspicious/noAssignInExpressions: 逐个消费全局正则匹配结果
    while ((match = regex.exec(result)) !== null) {
        const values: Record<string, string> = {};
        for (const line of match[1].split(/\r?\n/)) {
            const separator = line.indexOf("=");
            if (separator < 1) continue;
            values[line.slice(0, separator).trim()] = line
                .slice(separator + 1)
                .trim()
                .replace(/^["']|["']$/g, "");
        }
        blocks.push(values);
    }
    return blocks;
}

export function parseTaxonomyActions(result: string): TaxonomyAction[] {
    const parse = (tagName: string, kind: TaxonomyAction["kind"]) =>
        parseKeyValueBlocks(result, tagName).flatMap((value) => {
            const action = value.action?.toLowerCase();
            if (
                !action ||
                !["create", "rename", "merge", "delete"].includes(action)
            ) {
                return [];
            }
            return [
                {
                    kind,
                    action: action as TaxonomyAction["action"],
                    id: value.id,
                    targetId: value.targetId,
                    type:
                        value.categoryType === "income" ||
                        value.categoryType === "expense"
                            ? value.categoryType
                            : undefined,
                    name: value.name,
                    parentId: value.parentId,
                },
            ];
        });

    return [
        ...parse("CategoryAction", "category"),
        ...parse("TagAction", "tag"),
    ];
}
