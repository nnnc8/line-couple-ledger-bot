import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import Script from "next/script";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";
import "./style.css";

export const metadata: Metadata = {
  title: "共同帳本",
  description: "兩人的 LINE 分帳與生活帳務",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#0f2f52",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="zh-Hant" className="overscroll-none">
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <TooltipProvider delay={300}>
          {children}
        </TooltipProvider>
        <Toaster
          position="top-center"
          toastOptions={{
            style: {
              borderRadius: "14px",
              padding: "14px 16px",
              fontSize: "14px",
              fontWeight: 600,
            },
          }}
        />
        <Script
          src="https://static.line-scdn.net/liff/edge/2/sdk.js"
          strategy="afterInteractive"
          nonce={nonce}
        />
      </body>
    </html>
  );
}
