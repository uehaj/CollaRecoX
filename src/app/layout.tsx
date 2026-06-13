import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Collarecox - AI音声文字起こし",
  description: "オンデバイス音声認識による、ブラウザ完結のリアルタイム文字起こしと共同校正",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
