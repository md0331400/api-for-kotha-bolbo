import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kotha Bolbo Storage — Admin",
  description: "Private admin dashboard for the Kotha Bolbo Storage API",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
