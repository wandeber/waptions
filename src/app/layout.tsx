import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Waptions | Subtítulos sin dolor",
  description: "Tecnología inteligente para crear y editar subtítulos con precisión y velocidad. Simplifica tu proceso de edición hoy mismo.",
  icons: {
    icon: "/logo.png",
  },
};

import { SessionProvider } from "next-auth/react";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>
          {children}
        </SessionProvider>
      </body>
    </html>
  );
}
