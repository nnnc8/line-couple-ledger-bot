import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import Script from "next/script";

import "./style.css";

export const metadata: Metadata = {
  title: "共同帳本",
  description: "兩人的 LINE 分帳與生活帳務",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0f2f52",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="zh-Hant">
      <body>
        {children}
        <Script
          src="https://static.line-scdn.net/liff/edge/2/sdk.js"
          strategy="afterInteractive"
          nonce={nonce}
        />
      </body>
    </html>
  );
}
