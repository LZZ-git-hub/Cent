import dayjs from "dayjs";
import { v4 } from "uuid";
import { DefaultCurrencyId } from "@/api/currency/currencies";
import { getAllCurrencies } from "@/hooks/use-currency";
import { numberToAmount } from "@/ledger/bill";
import { BillCategories } from "@/ledger/category";
import type { Bill, BillCategory, BillTag, BillType } from "@/ledger/type";
import { locales } from "@/locale/utils";
import { useCurrencyStore } from "@/store/currency";
import { useLedgerStore } from "@/store/ledger";
import { usePreferenceStore } from "@/store/preference";
import { useUserStore } from "@/store/user";
import { requestAIForVoice } from "./request";
import {
    type ParsedBill,
    parseBillsFromResponse,
    parseTaxonomyActions,
    type TaxonomyAction,
} from "./text-to-bill-parser";

export { parseBillsFromResponse, parseTaxonomyActions };
export type { ParsedBill, TaxonomyAction };

const getCategories = (): BillCategory[] => {
    const savedCategories = useLedgerStore.getState().infos?.meta.categories;

    return savedCategories ?? BillCategories;
};

/**
 * 语音记账默认 prompt 模板。
 * 动态内容通过 {{变量}} 占位符表示，发起请求时由 renderVoicePrompt 替换为实际值。
 * 可用变量见 getVoicePromptVariables：
 *   {{currentTime}} {{locale}} {{categories}} {{tags}} {{taxonomyUsage}} {{tagGroups}}
 */
export const DEFAULT_VOICE_PROMPT_TEMPLATE = `你是一个会持续整理个人账本的记账助手。请从用户文本中提取账单，并根据用户真实使用情况维护分类和标签。
## 当前环境信息
**当前时间**: {{currentTime}}
**用户的语言偏好**: {{locale}}

下面是用户当前的分类（可能为空）：
\`\`\`plaintext
{{categories}}
\`\`\`
下面是用户当前的标签（可能为空）：
\`\`\`plaintext
{{tags}}
\`\`\`
下面是最近账单中的分类和标签使用次数：
\`\`\`plaintext
{{taxonomyUsage}}
\`\`\`

请严格按照以下 key=value XML 规范返回结果，不要使用 Markdown 代码块：
<Thought>
先分析账单，再规划分类和标签变化。分类要少而稳定：优先复用已有分类；只有已有分类明显不适合时才 create；只有两个分类重复、名称明显不合理或使用数据明确支持时才 rename/merge/delete。账单不足 5 笔时不要整理已有项，只允许按需 create。
分类 merge/delete 必须提供已有 id 和 targetId；不要凭空猜测 id。不要删除正在使用的分类，除非同时 merge 到 targetId。
标签用于旅行、项目、活动等跨分类主题，优先复用已有标签；不要为每笔普通消费创建标签。只删除长期无账单使用的标签。
Bill 的 category 和 tag 名称必须与 action 执行后的最终名称完全一致。新增标签时必须同时输出 TagAction create；不要只在 Bill 中写一个不存在的标签。
</Thought>
<CategoryAction>
action=create|rename|merge|delete
id=已有分类id（create 时省略）
targetId=合并目标分类id（仅 merge 时填写）
categoryType=expense|income（create 时必填）
name=分类名称（create/rename 时填写）
parentId=父分类id（可选）
</CategoryAction>
<TagAction>
action=create|rename|merge|delete
id=已有标签id（create 时省略）
targetId=合并目标标签id（仅 merge 时填写）
name=标签名称（create/rename 时填写）
</TagAction>
<Bill>
type=支出
category=餐饮
amount=100
note=烧烤
time=2026-01-01 12:00:00
</Bill>
Bill 可选字段：每个标签单独输出一行 tag=标签名称；只有用户明确使用其他币种时才输出 currency=币种代码。
分类和标签没有变化时不要输出对应 action。可以返回多个 Bill。
接下来用户将会提供文本供你分析：
`;

/**
 * 构建语音记账 prompt 中可用的变量及其当前值。
 * 占位符语法为 {{变量名}}。
 */
export const getVoicePromptVariables = (): Record<string, string> => {
    const meta = useLedgerStore.getState().infos?.meta;
    const userId = useUserStore.getState().id;

    const locale =
        locales.find((l) => l.name === usePreferenceStore.getState().locale)
            ?.label ?? "";

    const tags = meta?.tags ?? [];
    const tagGroups = userId ? (meta?.personal?.[userId]?.tagGroups ?? []) : [];
    const tagGroupsStr = tagGroups
        .map((group) => {
            const groupTags = (group.tagIds ?? [])
                .map((tid) => tags.find((t) => t.id === tid)?.name)
                .filter((v): v is string => Boolean(v));
            return `${group.name}: ${groupTags.join(" ")}`;
        })
        .join("\n");

    return {
        currentTime: dayjs().format("YYYY-MM-DD HH:mm:ss"),
        locale,
        categories: getCategoriesStr(),
        tags: getTagsStr(),
        taxonomyUsage: getTaxonomyUsageStr(),
        tagGroups: tagGroupsStr,
    };
};

/**
 * 将模板中的 {{变量}} 占位符替换为实际值。未知变量保持原样。
 */
export const renderVoicePrompt = (template: string): string => {
    const variables = getVoicePromptVariables();
    return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) =>
        name in variables ? variables[name] : match,
    );
};

/**
 * 获取当前生效的 prompt 模板：优先使用用户本地保存的自定义模板，否则使用默认模板。
 */
export const getVoicePromptTemplate = (): string =>
    usePreferenceStore.getState().voicePromptTemplate ??
    DEFAULT_VOICE_PROMPT_TEMPLATE;

/**
 * 生成一份完全内联（无占位符）的语音记账 prompt，供快捷指令等外部场景导出使用。
 * withTime 为 false 时不注入当前时间（导出的静态 prompt 不应包含会过期的时间）。
 */
export const textToBillSystemPrompt = (
    categoriesStr: string,
    withTime: boolean = true,
) => {
    const { currentTime, locale } = getVoicePromptVariables();
    const timeStr = withTime ? `**当前时间**: ${currentTime}` : "";
    return DEFAULT_VOICE_PROMPT_TEMPLATE.replace(
        "**当前时间**: {{currentTime}}",
        timeStr,
    )
        .replace("{{locale}}", locale)
        .replace("{{categories}}", categoriesStr)
        .replace("{{tags}}", getTagsStr())
        .replace("{{taxonomyUsage}}", getTaxonomyUsageStr());
};

export const getCategoriesStr = () => {
    const categories = getCategories();
    return categories.length
        ? categories
              .map(
                  (v) =>
                      `${v.name} | id=${v.id} | type=${v.type}${
                          v.parent ? ` | parent=${v.parent}` : ""
                      }`,
              )
              .join("\n")
        : "（暂无分类，请仅在确实需要时创建）";
};

export const getTagsStr = () => {
    const tags = useLedgerStore.getState().infos?.meta.tags ?? [];
    return tags.length
        ? tags.map((v) => `${v.name} | id=${v.id}`).join("\n")
        : "（暂无标签）";
};

export const getTaxonomyUsageStr = () => {
    const state = useLedgerStore.getState();
    const categories = state.infos?.meta.categories ?? BillCategories;
    const tags = state.infos?.meta.tags ?? [];
    const categoryCounts = new Map<string, number>();
    const tagCounts = new Map<string, number>();
    const categoryLastUsed = new Map<string, number>();
    const tagLastUsed = new Map<string, number>();
    for (const bill of state.bills) {
        categoryCounts.set(
            bill.categoryId,
            (categoryCounts.get(bill.categoryId) ?? 0) + 1,
        );
        categoryLastUsed.set(
            bill.categoryId,
            Math.max(categoryLastUsed.get(bill.categoryId) ?? 0, bill.time),
        );
        for (const tagId of bill.tagIds ?? []) {
            tagCounts.set(tagId, (tagCounts.get(tagId) ?? 0) + 1);
            tagLastUsed.set(
                tagId,
                Math.max(tagLastUsed.get(tagId) ?? 0, bill.time),
            );
        }
    }
    if (!state.bills.length) return "（暂无历史账单）";
    return [
        `最近账单数=${state.bills.length}`,
        ...categories.map(
            (category) =>
                `分类 ${category.name} | id=${category.id} | 使用=${
                    categoryCounts.get(category.id) ?? 0
                } | 最近=${
                    categoryLastUsed.has(category.id)
                        ? dayjs(categoryLastUsed.get(category.id)).format(
                              "YYYY-MM-DD",
                          )
                        : "从未"
                }`,
        ),
        ...tags.map(
            (tag) =>
                `标签 ${tag.name} | id=${tag.id} | 使用=${
                    tagCounts.get(tag.id) ?? 0
                } | 最近=${
                    tagLastUsed.has(tag.id)
                        ? dayjs(tagLastUsed.get(tag.id)).format("YYYY-MM-DD")
                        : "从未"
                }`,
        ),
    ].join("\n");
};

type TaxonomyResult = {
    categories: BillCategory[];
    tags: BillTag[];
    categoryAliases: Map<string, string>;
    tagAliases: Map<string, string>;
};

const categoryKey = (type: BillType, name: string) =>
    `${type}:${name.trim().toLowerCase()}`;

function billEntry(bill: Bill): Omit<Bill, "id" | "creatorId"> {
    const {
        id: _id,
        creatorId: _creatorId,
        __create_at: _created,
        __update_at: _updated,
        __delete_at: _deleted,
        ...entry
    } = bill as Bill & {
        __create_at?: number;
        __update_at?: number;
        __delete_at?: number;
    };
    return entry;
}

async function applyTaxonomyActions(
    actions: TaxonomyAction[],
    rawBills: ParsedBill[],
): Promise<TaxonomyResult> {
    const store = useLedgerStore.getState();
    let categories = (store.infos?.meta.categories ?? BillCategories).map(
        (category) => ({ ...category }),
    );
    let tags = (store.infos?.meta.tags ?? []).map((tag) => ({ ...tag }));
    const categoryAliases = new Map<string, string>();
    const tagAliases = new Map<string, string>();
    const tagRedirects = new Map<string, string | undefined>();
    const updatedBills = new Map<string, Bill>();
    let categoryCleanupCount = 0;
    let tagCleanupCount = 0;
    let metaChanged = false;
    let bills: Bill[] | undefined;
    const getBills = async () => {
        bills ??= await store.refreshBillList();
        return bills;
    };

    for (const action of actions) {
        if (action.kind === "category") {
            if (action.action === "create" && action.name && action.type) {
                const name = action.name.trim();
                const exists = categories.find(
                    (category) =>
                        category.type === action.type &&
                        category.name.toLowerCase() === name.toLowerCase(),
                );
                if (!exists && name) {
                    categories.push({
                        id: v4(),
                        name,
                        type: action.type,
                        parent:
                            action.parentId &&
                            categories.some(
                                (category) =>
                                    category.id === action.parentId &&
                                    category.type === action.type,
                            )
                                ? action.parentId
                                : undefined,
                        icon: "icon-[mdi--shape-outline]",
                        color: "#64748b",
                        customName: true,
                    });
                    metaChanged = true;
                }
                continue;
            }
            const source = action.id
                ? categories.find((category) => category.id === action.id)
                : undefined;
            if (!source) continue;
            if (categoryCleanupCount >= 1 || (await getBills()).length < 5) {
                continue;
            }
            if (action.action === "rename" && action.name?.trim()) {
                const name = action.name.trim();
                if (
                    categories.some(
                        (category) =>
                            category.id !== source.id &&
                            category.type === source.type &&
                            category.name.toLowerCase() === name.toLowerCase(),
                    )
                ) {
                    continue;
                }
                categoryAliases.set(
                    categoryKey(source.type, source.name),
                    source.id,
                );
                source.name = name;
                source.customName = true;
                categoryCleanupCount += 1;
                metaChanged = true;
            } else if (action.action === "merge" && action.targetId) {
                const target = categories.find(
                    (category) =>
                        category.id === action.targetId &&
                        category.type === source.type,
                );
                if (
                    !target ||
                    target.id === source.id ||
                    target.parent === source.id
                ) {
                    continue;
                }
                categoryAliases.set(
                    categoryKey(source.type, source.name),
                    target.id,
                );
                for (const bill of await getBills()) {
                    if (bill.categoryId === source.id) {
                        const current = updatedBills.get(bill.id) ?? bill;
                        updatedBills.set(bill.id, {
                            ...current,
                            categoryId: target.id,
                        });
                    }
                }
                categories = categories
                    .filter((category) => category.id !== source.id)
                    .map((category) =>
                        category.parent === source.id
                            ? { ...category, parent: target.id }
                            : category,
                    );
                categoryCleanupCount += 1;
                metaChanged = true;
            } else if (action.action === "delete") {
                const used = (await getBills()).some(
                    (bill) => bill.categoryId === source.id,
                );
                const hasChildren = categories.some(
                    (category) => category.parent === source.id,
                );
                if (!used && !hasChildren) {
                    categories = categories.filter(
                        (category) => category.id !== source.id,
                    );
                    categoryCleanupCount += 1;
                    metaChanged = true;
                }
            }
        } else {
            if (action.action === "create" && action.name) {
                const name = action.name.trim();
                const exists = tags.find(
                    (tag) => tag.name.toLowerCase() === name.toLowerCase(),
                );
                if (!exists && name) {
                    tags.push({ id: v4(), name });
                    metaChanged = true;
                }
                continue;
            }
            const source = action.id
                ? tags.find((tag) => tag.id === action.id)
                : undefined;
            if (!source) continue;
            if (tagCleanupCount >= 1 || (await getBills()).length < 5) {
                continue;
            }
            if (action.action === "rename" && action.name?.trim()) {
                const name = action.name.trim();
                if (
                    tags.some(
                        (tag) =>
                            tag.id !== source.id &&
                            tag.name.toLowerCase() === name.toLowerCase(),
                    )
                ) {
                    continue;
                }
                tagAliases.set(source.name.toLowerCase(), source.id);
                source.name = name;
                tagCleanupCount += 1;
                metaChanged = true;
            } else if (action.action === "merge" && action.targetId) {
                const target = tags.find((tag) => tag.id === action.targetId);
                if (!target || target.id === source.id) continue;
                tagAliases.set(source.name.toLowerCase(), target.id);
                for (const bill of await getBills()) {
                    if (bill.tagIds?.includes(source.id)) {
                        const current = updatedBills.get(bill.id) ?? bill;
                        updatedBills.set(bill.id, {
                            ...current,
                            tagIds: [
                                ...new Set(
                                    (current.tagIds ?? []).map((id) =>
                                        id === source.id ? target.id : id,
                                    ),
                                ),
                            ],
                        });
                    }
                }
                tags = tags.filter((tag) => tag.id !== source.id);
                tagRedirects.set(source.id, target.id);
                tagCleanupCount += 1;
                metaChanged = true;
            } else if (action.action === "delete") {
                const used = (await getBills()).some((bill) =>
                    bill.tagIds?.includes(source.id),
                );
                if (!used) {
                    tags = tags.filter((tag) => tag.id !== source.id);
                    tagRedirects.set(source.id, undefined);
                    tagCleanupCount += 1;
                    metaChanged = true;
                }
            }
        }
    }

    // AI 漏掉分类 create action 时仍需保证 Bill 可落库；标签则必须显式创建，
    // 避免每笔普通消费都生成新标签。
    for (const bill of rawBills) {
        const key = categoryKey(bill.type, bill.category);
        const categoryExists =
            categories.some(
                (category) =>
                    category.type === bill.type &&
                    category.name.toLowerCase() ===
                        bill.category.trim().toLowerCase(),
            ) || categoryAliases.has(key);
        if (!categoryExists) {
            categories.push({
                id: v4(),
                name: bill.category.trim(),
                type: bill.type,
                icon: "icon-[mdi--shape-outline]",
                color: "#64748b",
                customName: true,
            });
            metaChanged = true;
        }
    }

    if (updatedBills.size) {
        await store.updateBills(
            [...updatedBills.values()].map((bill) => ({
                id: bill.id,
                entry: billEntry(bill),
            })),
        );
    }
    if (metaChanged) {
        await store.updateGlobalMeta((prev) => {
            prev.categories = categories;
            prev.tags = tags;
            if (tagRedirects.size) {
                for (const personal of Object.values(prev.personal ?? {})) {
                    personal.tagGroups = personal.tagGroups?.map((group) => ({
                        ...group,
                        tagIds: [
                            ...new Set(
                                (group.tagIds ?? [])
                                    .map((id) =>
                                        tagRedirects.has(id)
                                            ? tagRedirects.get(id)
                                            : id,
                                    )
                                    .filter(
                                        (id): id is string => id !== undefined,
                                    ),
                            ),
                        ],
                    }));
                }
            }
            return prev;
        });
    }
    return { categories, tags, categoryAliases, tagAliases };
}

export async function parseTextToBill(text: string) {
    console.log("start parsing text:", text);
    const prompt = renderVoicePrompt(getVoicePromptTemplate());
    const result = await requestAIForVoice([
        { role: "system", content: prompt },
        {
            role: "user",
            content: `需要分析的文本：
            \`\`\`plaintext\n${text}\n\`\`\`
            `,
        },
    ]);
    return xmlTextToBills(result);
}

export async function xmlTextToBills(result: string) {
    const allCurrencies = getAllCurrencies();
    // 通过xml格式解析result，参考chat.ts中的parseStandardResponse，注意可能会有多个账单，需要返回一个数组
    const rawBills = parseBillsFromResponse(result);
    if (!rawBills.length) return [];
    const taxonomy = await applyTaxonomyActions(
        parseTaxonomyActions(result),
        rawBills,
    );
    const categories = taxonomy.categories;
    const allTags = taxonomy.tags;
    console.log("parsed bills:", rawBills);
    const bills = rawBills
        .map((raw) => {
            const type = raw.type;
            const categoryId =
                categories.find(
                    (v) =>
                        v.name.toLowerCase() ===
                            raw.category.trim().toLowerCase() &&
                        v.type === type,
                )?.id ??
                taxonomy.categoryAliases.get(categoryKey(type, raw.category));
            if (!categoryId) {
                return undefined;
            }
            const amount = numberToAmount(raw.amount);
            const comment = raw.note;
            const time = raw.time?.getTime() ?? Date.now();
            const tagIds = raw.tags
                ? [
                      ...new Set(
                          raw.tags
                              .map(
                                  (v) =>
                                      allTags.find(
                                          (tag) =>
                                              tag.name.toLowerCase() ===
                                              v.trim().toLowerCase(),
                                      )?.id ??
                                      taxonomy.tagAliases.get(
                                          v.trim().toLowerCase(),
                                      ),
                              )
                              .filter((v) => v !== undefined),
                      ),
                  ]
                : undefined;
            const currency = allCurrencies.find(
                (c) => c.label === raw.currency,
            );
            const baseCurrencyId =
                useLedgerStore.getState().infos?.meta.baseCurrency ??
                DefaultCurrencyId;
            if (!currency || currency.id === baseCurrencyId) {
                return {
                    type,
                    categoryId,
                    amount,
                    comment,
                    time,
                    tagIds,
                };
            }
            const { predict } = useCurrencyStore
                .getState()
                .convert(amount, currency.id, baseCurrencyId);
            return {
                type,
                categoryId,
                amount: predict,
                comment,
                time,
                tagIds,
                currency: {
                    base: baseCurrencyId,
                    target: currency.id,
                    amount: amount,
                },
            };
        })
        .filter((v) => v !== undefined);
    return bills;
}

// const testTextToBill = async (
//     testText = "今天在餐饮上花了100元，买了一些吃的",
// ) => {
//     const result = await parseTextToBill(testText);
//     console.log(result);
// };

// window.testTextToBill = testTextToBill;
