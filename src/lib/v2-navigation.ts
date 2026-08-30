export type V2SecondaryTab = "history" | "stats" | "settings";

/** Map public LIFF/Rich Menu tab values to the V2 Ledger sub-navigation. */
export function v2SecondaryTabFromUrlValue(value: string | null | undefined): V2SecondaryTab {
  switch (value) {
    case "analysis":
    case "stats":
      return "stats";
    case "recurring":
      return "settings";
    case "settings":
      return "settings";
    default:
      return "history";
  }
}
