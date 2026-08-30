import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
import { Toaster } from "sonner";
import { getSiteUrl } from "@/lib/site-url";
import { getSiteSettings } from "@/lib/site-settings";
import { Providers } from "@/components/providers";
import "./globals.css";

const fraunces = Fraunces({
  variable: "--font-display",
  subsets: ["latin"],
  display: "swap",
  axes: ["SOFT", "opsz"],
});

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

export async function generateMetadata(): Promise<Metadata> {
  const s = await getSiteSettings();
  const template = s.seo.titleTemplate.includes("%s") ? s.seo.titleTemplate : `%s · ${s.brand}`;
  return {
    metadataBase: new URL(getSiteUrl()),
    title: { default: s.seo.defaultTitle, template },
    description: s.seo.defaultDescription,
    applicationName: s.brand,
    ...(s.faviconUrl ? { icons: { icon: s.faviconUrl } } : {}),
    robots: s.seo.indexable ? undefined : { index: false, follow: false },
    openGraph: {
      siteName: s.brand,
      title: s.seo.defaultTitle,
      description: s.seo.defaultDescription,
      type: "website",
      ...(s.seo.ogImageUrl ? { images: [{ url: s.seo.ogImageUrl }] } : {}),
    },
  };
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${fraunces.variable} ${inter.variable} h-full`}>
      <body className="flex min-h-full flex-col">
        <Providers>{children}</Providers>
        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              background: "var(--color-ink)",
              color: "var(--color-paper)",
              border: "none",
              borderRadius: "8px",
              fontFamily: "var(--font-sans)",
            },
          }}
        />
      </body>
    </html>
  );
}
