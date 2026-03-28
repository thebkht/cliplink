import type { Metadata } from "next";
import { AppThemeProvider } from "./theme-provider";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://cliplink.thebkht.com"),
  title: "CLIPLINK",
  description: "Copy here. Paste anywhere. Fast cross-device clipboard sync.",
  openGraph: {
    title: "CLIPLINK",
    description: "Copy here. Paste anywhere. Fast cross-device clipboard sync.",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "CLIPLINK",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "CLIPLINK",
    description: "Copy here. Paste anywhere. Fast cross-device clipboard sync.",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <AppThemeProvider>{children}</AppThemeProvider>
      </body>
    </html>
  );
}
