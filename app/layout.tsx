import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CLIPLINK",
  description: "Copy here. Paste anywhere. Fast cross-device clipboard sync.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
