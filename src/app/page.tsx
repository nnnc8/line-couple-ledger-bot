"use client";

import dynamic from "next/dynamic";
import { V2LiffHome } from "@/components/ledger/v2-liff-home";

const LegacyHome = dynamic(() => import("@/components/legacy-home"), { ssr: false });

export default function Home() {
  return process.env.NEXT_PUBLIC_V2_LEDGER_UI === "1" ? <V2LiffHome /> : <LegacyHome />;
}
