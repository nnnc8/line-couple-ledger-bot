/**
 * flex-message-builder — LINE Flex Message templates.
 *
 * Provides builder functions for the common reply patterns:
 *   - flexExpenseConfirm  → 記帳成功卡片
 *   - flexQueryResult     → 查帳結果卡片
 *   - flexNeedsGroup      → 群組選擇卡片
 *   - flexError           → 錯誤提示卡片
 *
 * Each builder returns a `LineReplyMessage` that can be sent via
 * `replyMessages` in `line-bot-shared.ts`.
 */

export type FlexContainer = {
  type: "bubble";
  header?: FlexBox;
  body?: FlexBox;
  footer?: FlexBox;
  styles?: Record<string, unknown>;
};

export type FlexBox = {
  type: "box";
  layout: "vertical" | "horizontal";
  contents: FlexComponent[];
  spacing?: string;
  margin?: string;
  paddingAll?: string;
  backgroundColor?: string;
  cornerRadius?: string;
};

export type FlexComponent =
  | { type: "text"; text: string; size?: string; weight?: "bold" | "regular"; color?: string; flex?: number; margin?: string; wrap?: boolean; align?: "start" | "center" | "end" }
  | { type: "separator"; margin?: string }
  | { type: "spacer"; size?: string }
  | { type: "box"; layout: "vertical" | "horizontal"; contents: FlexComponent[]; spacing?: string; margin?: string; flex?: number }
  | { type: "button"; action: FlexAction; style?: "link" | "primary" | "secondary"; color?: string; margin?: string; height?: string }
  | { type: "image"; url: string; size?: string; aspectMode?: "cover" | "fit"; flex?: number; margin?: string };

export type FlexAction =
  | { type: "message"; label: string; text: string }
  | { type: "uri"; label: string; uri: string };

export type LineReplyMessage =
  | { type: "text"; text: string }
  | { type: "flex"; altText: string; contents: FlexContainer };

export interface ExpenseConfirmParams {
  description: string;
  amountTwd: number;
  tag?: string;
  paidBy: "self" | "partner";
  ledger: "shared" | "private";
  groupName?: string;
  balanceText?: string;
}

export function flexExpenseConfirm(params: ExpenseConfirmParams): LineReplyMessage {
  const ledgerLabel = params.ledger === "private" ? "私人帳" : "共同帳";
  const paidByLabel = params.paidBy === "self" ? "你付" : "對方付";
  const tagLine = params.tag ? `${params.tag}` : "未分類";
  const groupLine = params.groupName ? `\n群組：${params.groupName}` : "";
  const balanceLine = params.balanceText ? `\n餘額：${params.balanceText}` : "";

  return {
    type: "flex",
    altText: `已記帳 ${params.description} NT$${params.amountTwd}`,
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "已記帳",
            size: "lg",
            weight: "bold",
            color: "#1DB446",
          },
        ],
        paddingAll: "md",
        backgroundColor: "#F8F9FA",
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: params.description,
            size: "xl",
            weight: "bold",
            wrap: true,
            margin: "none",
          },
          {
            type: "text",
            text: `NT$${params.amountTwd.toLocaleString()} · ${paidByLabel} · ${ledgerLabel}`,
            size: "md",
            color: "#666666",
            margin: "sm",
          },
          {
            type: "separator",
            margin: "md",
          },
          {
            type: "box",
            layout: "horizontal",
            contents: [
              {
                type: "text",
                text: "標籤",
                size: "sm",
                color: "#999999",
                flex: 2,
              },
              {
                type: "text",
                text: tagLine,
                size: "sm",
                weight: "bold",
                flex: 3,
              },
            ],
            margin: "md",
          },
          {
            type: "text",
            text: `${groupLine}${balanceLine}`.trim(),
            size: "sm",
            color: "#999999",
            margin: "sm",
            wrap: true,
          },
        ],
        paddingAll: "md",
      },
    },
  };
}

export interface QueryResultParams {
  title: string;
  totalTwd: number;
  count: number;
  topTags?: Array<{ label: string; amount: number; percent: number }>;
  vsLastMonthPercent?: number;
  liffUrl?: string;
}

export function flexQueryResult(params: QueryResultParams): LineReplyMessage {
  const tagLines: FlexComponent[] = (params.topTags ?? []).slice(0, 3).map((t) => ({
    type: "box" as const,
    layout: "horizontal" as const,
    contents: [
      {
        type: "text",
        text: t.label,
        size: "sm",
        color: "#666666",
        flex: 3,
      },
      {
        type: "text",
        text: `NT$${t.amount.toLocaleString()} (${t.percent}%)`,
        size: "sm",
        weight: "bold",
        flex: 4,
        align: "end",
      },
    ],
    margin: "sm",
  }));

  const trendLine: FlexComponent[] = params.vsLastMonthPercent != null
    ? [{
        type: "text",
        text: params.vsLastMonthPercent >= 0
          ? `較上月 ↑${params.vsLastMonthPercent}%`
          : `較上月 ↓${Math.abs(params.vsLastMonthPercent)}%`,
        size: "sm",
        color: params.vsLastMonthPercent >= 0 ? "#E63946" : "#1DB446",
        margin: "sm",
      }]
    : [];

  const footerContents: FlexComponent[] = params.liffUrl
    ? [{
        type: "button",
        action: { type: "uri", label: "查看明細", uri: params.liffUrl },
        style: "link",
        color: "#2563EB",
      }]
    : [];

  return {
    type: "flex",
    altText: `${params.title} NT$${params.totalTwd.toLocaleString()} ${params.count}筆`,
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: params.title,
            size: "md",
            color: "#666666",
          },
          {
            type: "text",
            text: `NT$${params.totalTwd.toLocaleString()}`,
            size: "xxl",
            weight: "bold",
            color: "#1A1A1A",
            margin: "xs",
          },
          {
            type: "text",
            text: `${params.count} 筆`,
            size: "sm",
            color: "#999999",
            margin: "xs",
          },
        ],
        paddingAll: "md",
        backgroundColor: "#F0F4FF",
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          ...tagLines,
          ...trendLine,
        ],
        paddingAll: "md",
      },
      ...(footerContents.length > 0 ? { footer: { type: "box", layout: "vertical", contents: footerContents } } : {}),
    },
  };
}

export function flexNeedsGroup(
  groups: Array<{ id: string; name: string }>,
): LineReplyMessage {
  const groupNames = groups.map((g) => g.name).join("、");
  const buttons: FlexComponent[] = groups.slice(0, 4).map((g) => ({
    type: "button",
    action: { type: "message", label: g.name, text: g.name },
    style: "primary",
    color: "#2563EB",
    margin: "sm",
  }));

  const hint: FlexComponent = {
    type: "text",
    text: `或直接打「群組名＋內容」，例如「${groups[0]?.name ?? "群組"} 晚餐 500 我付」`,
    size: "xs",
    color: "#999999",
    margin: "md",
    wrap: true,
  };

  return {
    type: "flex",
    altText: `要記到哪個群組？你的群組有：${groupNames}`,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "要記到哪個群組？",
            size: "lg",
            weight: "bold",
            margin: "none",
          },
          ...buttons,
          hint,
        ],
        paddingAll: "md",
      },
    },
  };
}

export function flexError(message: string): LineReplyMessage {
  return {
    type: "flex",
    altText: message,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "⚠️",
            size: "xl",
            margin: "none",
          },
          {
            type: "text",
            text: message,
            size: "md",
            color: "#666666",
            margin: "sm",
            wrap: true,
          },
        ],
        paddingAll: "md",
      },
    },
  };
}
