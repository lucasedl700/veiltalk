import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "next-themes";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "VeilTalk 纱语 · 端到端加密网页通话与文件直传",
  description:
    "基于最新 WebRTC 标准自研：逐帧 AES-256-GCM 端到端加密的浏览器音视频通话，DataChannel 加密文件直传，自建信令服务器与 TURN/STUN，支持 Docker 一键部署。",
  keywords: [
    "WebRTC",
    "端到端加密",
    "E2EE",
    "视频通话",
    "文件传输",
    "Insertable Streams",
    "RTCRtpScriptTransform",
    "TURN",
    "coturn",
  ],
  manifest: "/manifest.webmanifest",
  applicationName: "VeilTalk",
  appleWebApp: {
    capable: true,
    title: "VeilTalk",
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false },
  icons: {
    icon: [
      { url: "/logo.svg", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/icon-180.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0d9488",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
