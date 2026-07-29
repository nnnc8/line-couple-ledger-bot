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

import { buildLiffUrl } from "./liff-url";

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
  | { type: "button"; action: FlexAction; style?: "link" | "primary" | "secondary"; color?: string; margin?: string; height?: string; flex?: number }
  | { type: "image"; url: string; size?: string; aspectMode?: "cover" | "fit"; flex?: number; margin?: string };

export type FlexAction =
  | { type: "message"; label: string; text: string }
  | { type: "uri"; label: string; uri: string }
  | {
      type: "postback";
      label: string;
      data: string;
      displayText?: string;
      inputOption?: "closeRichMenu" | "openRichMenu" | "openKeyboard" | "openVoice";
      fillInText?: string;
    };

export type QuickReplyAction = FlexAction;

export type QuickReplyItem = {
  type: "action";
  action: QuickReplyAction;
};

export type QuickReply = {
  items: QuickReplyItem[];
};

export type LineReplyMessage =
  | { type: "text"; text: string; quickReply?: QuickReply }
  | { type: "flex"; altText: string; contents: FlexContainer };

export function quickReplyText(
  text: string,
  actions: QuickReplyAction[],
): LineReplyMessage {
  return {
    type: "text",
    text,
    quickReply: {
      items: actions.slice(0, 13).map((action) => ({
        type: "action",
        action,
      })),
    },
  };
}

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

export interface ExpensePendingParams {
  actionId: string;
  description: string;
  amountTwd: number;
  tag: string;
  paidByLabel: string;
  ledgerLabel: string;
  groupName?: string;
}

export function flexExpensePending(
  params: ExpensePendingParams,
): LineReplyMessage {
  const actionData = (decision: "confirm" | "cancel") =>
    `decision=${decision}&id=${encodeURIComponent(params.actionId)}`;
  return {
    type: "flex",
    altText: `確認記帳 ${params.description} NT$${params.amountTwd.toLocaleString()}`,
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "確認記帳", size: "lg", weight: "bold" },
          {
            type: "text",
            text: `NT$${params.amountTwd.toLocaleString()}`,
            size: "xxl",
            weight: "bold",
            color: "#2563EB",
            margin: "xs",
          },
        ],
        paddingAll: "md",
        backgroundColor: "#EFF6FF",
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
          },
          {
            type: "text",
            text: `${params.tag} · ${params.paidByLabel} · ${params.ledgerLabel}`,
            size: "sm",
            color: "#666666",
            margin: "sm",
            wrap: true,
          },
          ...(params.groupName
            ? [{
                type: "text" as const,
                text: `群組：${params.groupName}`,
                size: "sm",
                color: "#888888",
                margin: "sm",
                wrap: true,
              }]
            : []),
          {
            type: "text",
            text: "10 分鐘內有效；確認前不會入帳。",
            size: "xs",
            color: "#999999",
            margin: "md",
          },
        ],
        paddingAll: "md",
      },
      footer: {
        type: "box",
        layout: "horizontal",
        contents: [
          {
            type: "button",
            action: {
              type: "postback",
              label: "取消",
              data: actionData("cancel"),
            },
            style: "secondary",
            flex: 1,
          },
          {
            type: "button",
            action: {
              type: "postback",
              label: "確認",
              data: actionData("confirm"),
            },
            style: "primary",
            color: "#2563EB",
            margin: "sm",
            flex: 1,
          },
        ],
        spacing: "sm",
        paddingAll: "md",
      },
    },
  };
}

export function flexImageUnsupported(liffId: string): LineReplyMessage {
  return {
    type: "flex",
    altText: "目前不支援收據圖片辨識",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "圖片暫不自動入帳",
            size: "lg",
            weight: "bold",
          },
          {
            type: "text",
            text: "請使用快速記帳，或開啟完整表單輸入內容。",
            size: "sm",
            color: "#666666",
            margin: "sm",
            wrap: true,
          },
        ],
        paddingAll: "md",
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            action: {
              type: "postback",
              label: "快速記帳",
              data: "m=1&a=expense",
            },
            style: "primary",
            color: "#2563EB",
          },
          {
            type: "button",
            action: {
              type: "uri",
              label: "開啟完整表單",
              uri: buildLiffUrl(liffId, { action: "expense" }),
            },
            style: "link",
            margin: "sm",
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

export interface TransferConfirmParams {
  actionId: string;
  intent: "transfer" | "settle";
  directionLabel: string;
  amountTwd: number;
  groupName: string;
  beforeBalanceText: string;
  afterBalanceText: string;
  warning?: string;
}

export function flexTransferConfirm(
  params: TransferConfirmParams,
): LineReplyMessage {
  const title = params.intent === "settle" ? "確認還款" : "確認轉帳";
  const detailRows: FlexComponent[] = [
    ["方向", params.directionLabel],
    ["群組", params.groupName],
    ["目前餘額", params.beforeBalanceText],
    ["記錄後", params.afterBalanceText],
  ].map(([label, value]) => ({
    type: "box" as const,
    layout: "horizontal" as const,
    contents: [
      { type: "text", text: label!, size: "sm", color: "#777777", flex: 2 },
      {
        type: "text",
        text: value!,
        size: "sm",
        weight: "bold",
        align: "end",
        flex: 4,
        wrap: true,
      },
    ],
    margin: "sm",
  }));
  const actionData = (decision: "confirm" | "cancel") =>
    `decision=${decision}&id=${encodeURIComponent(params.actionId)}`;

  return {
    type: "flex",
    altText: `${title} ${params.directionLabel} NT$${params.amountTwd.toLocaleString()}`,
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: title, size: "lg", weight: "bold" },
          {
            type: "text",
            text: `NT$${params.amountTwd.toLocaleString()}`,
            size: "xxl",
            weight: "bold",
            color: "#1D4ED8",
            margin: "xs",
          },
        ],
        paddingAll: "md",
        backgroundColor: "#EFF6FF",
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          ...detailRows,
          ...(params.warning
            ? [{
                type: "text" as const,
                text: params.warning,
                size: "sm",
                color: "#B45309",
                margin: "md",
                wrap: true,
              }]
            : []),
          {
            type: "text",
            text: "10 分鐘內有效；確認前不會入帳。",
            size: "xs",
            color: "#999999",
            margin: "md",
            wrap: true,
          },
        ],
        paddingAll: "md",
      },
      footer: {
        type: "box",
        layout: "horizontal",
        contents: [
          {
            type: "button",
            action: {
              type: "postback",
              label: "取消",
              data: actionData("cancel"),
            },
            style: "secondary",
            flex: 1,
          },
          {
            type: "button",
            action: {
              type: "postback",
              label: "確認",
              data: actionData("confirm"),
            },
            style: "primary",
            color: "#2563EB",
            margin: "sm",
            flex: 1,
          },
        ],
        spacing: "sm",
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
