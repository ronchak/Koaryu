import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { APP_DESCRIPTION, APP_NAME } from "@/lib/constants";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

const appTitle = `${APP_NAME} — Martial Arts Studio OS`;
const appDescription =
  `${APP_DESCRIPTION} Student CRM, belt progression, scheduling, billing, and more — built for how dojos actually operate.`;

export const metadata: Metadata = {
  applicationName: APP_NAME,
  title: appTitle,
  description: appDescription,
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico" },
    ],
    shortcut: [{ url: "/favicon.ico" }],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  },
  openGraph: {
    type: "website",
    title: appTitle,
    description: appDescription,
    siteName: APP_NAME,
  },
  twitter: {
    card: "summary",
    title: appTitle,
    description: appDescription,
  },
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#0B0D10",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} h-full`}
    >
      <body className="min-h-full flex flex-col font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
