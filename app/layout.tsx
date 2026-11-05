import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "멀린 자금관리 | Finance Desk",
  description: "직접 설치해 사용하는 오픈소스 자금관리 도구. 사업자별 현금흐름, 거래 분류와 가용자금을 한곳에서 관리하세요.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className="antialiased">{children}</body>
    </html>
  );
}
